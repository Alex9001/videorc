//! Sample clock for the debug-only synthetic microphone; never a hardware clock policy.
use std::time::{Duration, Instant};

const PACKET_DURATION: Duration = Duration::from_millis(super::CAPTION_CONTRACT_TEST_PACKET_MS);
const PACKET_FRAMES: u64 =
    super::NATIVE_AUDIO_SAMPLE_RATE as u64 * super::CAPTION_CONTRACT_TEST_PACKET_MS / 1_000;
const MAX_CATCH_UP: Duration = Duration::from_secs(1);

pub(crate) struct FixtureAudioClock {
    next_tick: Instant,
    packet_index: u64,
}

pub(crate) struct FixturePacketTiming {
    pub frame_cursor: u64,
    pub captured_at: Instant,
    pub skipped_frames: u64,
}

impl FixtureAudioClock {
    pub fn new(now: Instant) -> Self {
        Self {
            next_tick: now,
            packet_index: 0,
        }
    }

    pub fn deadline(&self) -> Instant {
        self.next_tick
    }

    pub fn next_packet(&mut self, now: Instant) -> FixturePacketTiming {
        // Keep sample time anchored after late wakes. Resetting this deadline to
        // `now` makes every scheduler pause permanent device-clock drift.
        // Skip only samples already beyond a one-second catch-up budget; their
        // timestamp gap remains observable instead of replaying old tone forever.
        let expired = now
            .saturating_duration_since(self.next_tick)
            .saturating_sub(MAX_CATCH_UP);
        let skipped_packets = expired.as_nanos().div_ceil(PACKET_DURATION.as_nanos()) as u64;
        self.packet_index += skipped_packets;
        self.next_tick += Duration::from_millis(
            skipped_packets.saturating_mul(super::CAPTION_CONTRACT_TEST_PACKET_MS),
        );
        let result = FixturePacketTiming {
            frame_cursor: self.packet_index * PACKET_FRAMES,
            captured_at: self.next_tick,
            skipped_frames: skipped_packets * PACKET_FRAMES,
        };
        self.packet_index += 1;
        self.next_tick += PACKET_DURATION;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_late_wakes_do_not_accumulate_synthetic_sample_clock_drift() {
        let epoch = Instant::now();
        let mut clock = FixtureAudioClock::new(epoch);
        let mut now = epoch;
        for index in 0..600 {
            now = now.max(clock.deadline());
            // A transient scheduling delay every tenth packet; no real sleeps.
            if index % 10 == 9 {
                now += Duration::from_millis(38);
            }
            let timing = clock.next_packet(now);
            assert_eq!(timing.frame_cursor, index * 960);
            assert_eq!(timing.skipped_frames, 0);
            assert_eq!(
                timing.captured_at,
                epoch + Duration::from_millis(index * 20)
            );
            now += Duration::from_millis(1); // bounded generation cost
        }
        assert_eq!(clock.deadline(), epoch + Duration::from_secs(12));
    }

    #[test]
    fn long_stall_discards_only_expired_fixture_samples_and_bounds_catchup() {
        let epoch = Instant::now();
        let mut clock = FixtureAudioClock::new(epoch);
        let now = epoch + Duration::from_secs(10);
        let packet = clock.next_packet(now);
        assert_eq!(packet.skipped_frames, 9 * 48_000);
        assert_eq!(packet.frame_cursor, packet.skipped_frames);
        assert_eq!(now.duration_since(packet.captured_at), MAX_CATCH_UP);
        let mut packets = 1;
        while clock.deadline() <= now {
            clock.next_packet(now);
            packets += 1;
        }
        assert_eq!(packets, 51);
        assert_eq!(clock.deadline(), now + PACKET_DURATION);
    }
}
