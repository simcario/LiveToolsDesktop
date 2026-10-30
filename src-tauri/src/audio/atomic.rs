use std::sync::atomic::{AtomicU32, Ordering};

/// f32 shared between the UI threads and the audio callback without locks.
#[derive(Debug, Default)]
pub struct AtomicF32(AtomicU32);

impl AtomicF32 {
    pub fn new(v: f32) -> Self {
        Self(AtomicU32::new(v.to_bits()))
    }

    pub fn load(&self) -> f32 {
        f32::from_bits(self.0.load(Ordering::Relaxed))
    }

    pub fn store(&self, v: f32) {
        self.0.store(v.to_bits(), Ordering::Relaxed);
    }

    pub fn swap(&self, v: f32) -> f32 {
        f32::from_bits(self.0.swap(v.to_bits(), Ordering::Relaxed))
    }

    /// Peak meters: the audio thread is the only writer, the UI resets with swap.
    pub fn store_max(&self, v: f32) {
        if v > self.load() {
            self.store(v);
        }
    }
}
