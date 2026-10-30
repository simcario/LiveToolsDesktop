//! Streaming stereo resampler (Catmull-Rom cubic interpolation), used when a
//! file's sample rate differs from the audio interface's.

pub struct Resampler {
    /// Source frames per output frame.
    ratio: f64,
    pos: f64,
    /// Pending interleaved stereo input; buf[0..2] is one frame of history.
    buf: Vec<f32>,
    primed: bool,
}

fn cubic(y0: f32, y1: f32, y2: f32, y3: f32, t: f32) -> f32 {
    let a = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
    let b = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    let c = -0.5 * y0 + 0.5 * y2;
    ((a * t + b) * t + c) * t + y1
}

impl Resampler {
    pub fn new(src_rate: u32, dst_rate: u32) -> Self {
        Self { ratio: src_rate as f64 / dst_rate as f64, pos: 0.0, buf: Vec::new(), primed: false }
    }

    pub fn is_passthrough(&self) -> bool {
        (self.ratio - 1.0).abs() < 1e-9
    }

    /// Appends interleaved stereo input, pushes interleaved stereo output.
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if self.is_passthrough() {
            out.extend_from_slice(input);
            return;
        }
        if !self.primed && input.len() >= 2 {
            // One frame of history so the first output lands on the first input frame.
            self.buf.extend_from_slice(&input[..2]);
            self.primed = true;
        }
        self.buf.extend_from_slice(input);
        let frames = self.buf.len() / 2;
        loop {
            let i = self.pos as usize;
            if i + 3 >= frames {
                break;
            }
            let t = (self.pos - i as f64) as f32;
            for c in 0..2 {
                let y = |k: usize| self.buf[(i + k) * 2 + c];
                out.push(cubic(y(0), y(1), y(2), y(3), t));
            }
            self.pos += self.ratio;
        }
        let consumed = (self.pos as usize).min(frames);
        if consumed > 0 {
            self.buf.drain(..consumed * 2);
            self.pos -= consumed as f64;
        }
    }

    /// Emits the tail at the end of the file.
    pub fn flush(&mut self, out: &mut Vec<f32>) {
        if !self.is_passthrough() {
            self.process(&[0.0; 6], out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_length_follows_ratio() {
        let mut r = Resampler::new(44_100, 48_000);
        let input = vec![0.25f32; 44_100 * 2];
        let mut out = Vec::new();
        for chunk in input.chunks(1024) {
            r.process(chunk, &mut out);
        }
        r.flush(&mut out);
        let frames = out.len() / 2;
        assert!((frames as i64 - 48_000).abs() < 8, "{frames}");
        assert!((out[1000] - 0.25).abs() < 1e-4);
    }
}
