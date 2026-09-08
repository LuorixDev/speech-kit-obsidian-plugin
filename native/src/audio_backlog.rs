use std::collections::HashMap;
use uuid::Uuid;

#[derive(Default)]
pub struct AudioBacklog {
    utterances: HashMap<Uuid, (u64, u64)>,
}

impl AudioBacklog {
    pub fn receive(&mut self, id: Uuid, samples: usize, append: bool) {
        let entry = self.utterances.entry(id).or_default();
        entry.0 = if append { entry.0.saturating_add(samples as u64) }
            else { entry.0.max(samples as u64) };
    }

    pub fn acknowledge(&mut self, id: Uuid, samples: usize) {
        if let Some(entry) = self.utterances.get_mut(&id) {
            entry.1 = entry.1.max(samples as u64).min(entry.0);
        }
    }

    pub fn finish(&mut self, id: Uuid) { self.utterances.remove(&id); }

    pub fn queued_ms(&self) -> u64 {
        // The inference queue uses 16 kHz mono PCM. Count audio work, not wall
        // time: silence and already-processed, unfinalized text are not backlog.
        self.utterances.values().map(|(received, processed)| received - processed).sum::<u64>() / 16
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_frames_inside_one_open_sentence_and_in_flight_work() {
        let mut backlog = AudioBacklog::default();
        let id = Uuid::new_v4();
        backlog.receive(id, 16000, false);
        backlog.receive(id, 32000, true);
        assert_eq!(backlog.queued_ms(), 3000);
        backlog.acknowledge(id, 16000);
        assert_eq!(backlog.queued_ms(), 2000);
        backlog.acknowledge(id, 48000);
        assert_eq!(backlog.queued_ms(), 0);
    }

    #[test]
    fn finalization_does_not_double_count_streamed_audio_or_leave_stale_progress() {
        let mut backlog = AudioBacklog::default();
        let id = Uuid::new_v4();
        backlog.receive(id, 32000, false);
        backlog.acknowledge(id, 32000);
        backlog.receive(id, 40000, false);
        assert_eq!(backlog.queued_ms(), 500);
        backlog.finish(id);
        backlog.acknowledge(id, 40000);
        assert_eq!(backlog.queued_ms(), 0);
    }
}
