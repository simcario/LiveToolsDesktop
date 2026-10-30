//! Tempo map of a song, same rules as the web metronome (web/src/lib/metronome.js):
//! optional count-in, then the sections in order, the last one repeating.
//! Compound meters (6/8, 9/8, 12/8) click in eighths and the BPM refers to the
//! dotted quarter.
//!
//! The map can be lined up with the audio (see beats.rs): either shifted so
//! that bar 1 starts at `origin`, built bar by bar from the beats of a
//! recorded click track, or warped by hand through anchors (a beat pinned to
//! a time of the audio, constant tempo between two anchors).

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionSpec {
    pub label: Option<String>,
    pub bars: Option<f64>,
    pub bpm: Option<f64>,
    pub time_sig: Option<String>,
}

/// How the grid is lined up with the audio.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SyncSpec {
    /// Bar 1 at `origin` seconds; `bpm` replaces the song's tempo when given.
    Offset { origin: f64, bpm: Option<f64> },
    /// Beats of a click track, starting from bar 1.
    Beats { beats: Vec<f64>, beats_per_bar: u32 },
    /// Warp anchors set by hand; `bpm` is the tempo when there is only one.
    Anchors { anchors: Vec<Anchor>, bpm: Option<f64> },
}

/// A beat of the grid (0 = bar 1, beat 1; counted in clicks of the song's
/// meter) pinned to a time of the audio.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct Anchor {
    pub beat: u32,
    pub t: f64,
}

/// One segment of the map, in seconds (sent to the UI to draw the grid).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub start: f64,
    /// Seconds between two clicks.
    pub beat: f64,
    /// Clicks in a bar.
    pub beats: u32,
    pub compound: bool,
    /// None: repeats until the end of the song.
    pub bars: Option<u32>,
    pub bpm: f64,
    pub time_sig: String,
    pub label: String,
    /// Number of the first bar (count-in bars are negative).
    pub first_bar: i64,
    /// Beat of that bar the segment starts on (0 = on the bar line).
    pub first_beat: u32,
    /// Clicks in the segment when it is not made of whole bars (warp).
    pub clicks: Option<u32>,
    pub count_in: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoMap {
    pub segments: Vec<Segment>,
    /// Length of the count-in in seconds (it ends on bar 1).
    pub count_in: f64,
    /// Time of bar 1, beat 1.
    pub origin: f64,
    /// Silence needed before the audio for the count-in (count_in - origin, if positive).
    pub pre_roll: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClickKind {
    Accent,
    Count,
    Group,
    Beat,
}

fn parse_sig(sig: &str) -> (u32, u32) {
    let mut it = sig.split('/');
    let n = it.next().and_then(|x| x.trim().parse().ok()).unwrap_or(4);
    let d = it.next().and_then(|x| x.trim().parse().ok()).unwrap_or(4);
    (if (1..=16).contains(&n) { n } else { 4 }, d)
}

fn is_compound(sig: &str) -> bool {
    let (n, d) = parse_sig(sig);
    d == 8 && n % 3 == 0 && n > 3
}

struct Plan {
    bars: Option<u32>,
    bpm: f64,
    sig: String,
    label: String,
}

fn plan(bpm: Option<f64>, time_sig: Option<&str>, sections: &[SectionSpec]) -> Vec<Plan> {
    let base_bpm = bpm.filter(|b| *b > 0.0).unwrap_or(120.0);
    let base_sig = time_sig.filter(|s| !s.trim().is_empty()).unwrap_or("4/4").to_string();
    let mut plan: Vec<Plan> = sections
        .iter()
        .filter(|s| s.bpm.unwrap_or(0.0) > 0.0 || s.time_sig.as_deref().is_some_and(|t| !t.is_empty()))
        .map(|s| Plan {
            bars: Some(s.bars.unwrap_or(1.0).max(1.0) as u32),
            bpm: s.bpm.filter(|b| *b > 0.0).unwrap_or(base_bpm),
            sig: s.time_sig.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| base_sig.clone()),
            label: s.label.clone().unwrap_or_default(),
        })
        .collect();
    if plan.is_empty() {
        plan.push(Plan { bars: None, bpm: base_bpm, sig: base_sig, label: String::new() });
    }
    if let Some(last) = plan.last_mut() {
        last.bars = None;
    }
    plan
}

fn segment(p: &Plan, start: f64, first_bar: i64, count_in: bool, bars: Option<u32>) -> Segment {
    let compound = is_compound(&p.sig);
    let (beats, _) = parse_sig(&p.sig);
    let beat = if compound { 60.0 / p.bpm / 3.0 } else { 60.0 / p.bpm };
    Segment {
        start,
        beat,
        beats,
        compound,
        bars,
        bpm: p.bpm,
        time_sig: p.sig.clone(),
        label: if count_in { "Count-in".into() } else { p.label.clone() },
        first_bar,
        first_beat: 0,
        clicks: None,
        count_in,
    }
}

impl TempoMap {
    pub fn build(bpm: Option<f64>, time_sig: Option<&str>, count_in_bars: u32, sections: &[SectionSpec]) -> Self {
        Self::build_at(bpm, time_sig, count_in_bars, sections, 0.0)
    }

    /// Song tempo and sections with bar 1 at `origin`.
    pub fn build_at(bpm: Option<f64>, time_sig: Option<&str>, count_in_bars: u32, sections: &[SectionSpec], origin: f64) -> Self {
        let plan = plan(bpm, time_sig, sections);
        let mut segments = Vec::new();
        let mut t = origin;
        let mut bar = 1i64;
        for p in &plan {
            let seg = segment(p, t, bar, false, p.bars);
            if let Some(b) = p.bars {
                t += seg.beat * seg.beats as f64 * b as f64;
                bar += b as i64;
            }
            segments.push(seg);
        }
        Self::with_count_in(segments, &plan[0], count_in_bars, origin)
    }

    /// One segment per bar from the beats of a click track (bar 1 = beats[0]).
    /// Section labels from the song are placed on their bars.
    pub fn from_beats(
        beats: &[f64],
        beats_per_bar: u32,
        time_sig: Option<&str>,
        count_in_bars: u32,
        sections: &[SectionSpec],
    ) -> Self {
        let bpb = beats_per_bar.clamp(1, 16) as usize;
        let sig = time_sig.filter(|s| !s.trim().is_empty()).unwrap_or("4/4").to_string();
        // Bar where each labelled section starts.
        let mut labels = Vec::new();
        let mut at = 0usize;
        for s in sections {
            if let Some(l) = s.label.as_ref().filter(|l| !l.is_empty()) {
                labels.push((at, l.clone()));
            }
            at += s.bars.unwrap_or(0.0).max(0.0) as usize;
        }
        let bars = beats.len() / bpb;
        let mut segments = Vec::with_capacity(bars + 1);
        let mut last_beat = 0.5;
        for k in 0..bars.max(1) {
            let s = beats[(k * bpb).min(beats.len() - 1)];
            let next = beats.get((k + 1) * bpb).copied();
            let beat = match next {
                Some(e) => (e - s) / bpb as f64,
                None => {
                    // Last (partial) bar: tempo of its last beats.
                    let tail = &beats[k * bpb..];
                    if tail.len() >= 2 {
                        (tail[tail.len() - 1] - tail[0]) / (tail.len() - 1) as f64
                    } else {
                        last_beat
                    }
                }
            };
            last_beat = beat;
            segments.push(Segment {
                start: s,
                beat,
                beats: bpb as u32,
                compound: false,
                bars: if next.is_some() { Some(1) } else { None },
                bpm: 60.0 / beat,
                time_sig: sig.clone(),
                label: labels.iter().find(|(b, _)| *b == k).map(|(_, l)| l.clone()).unwrap_or_default(),
                first_bar: k as i64 + 1,
                first_beat: 0,
                clicks: None,
                count_in: false,
            });
        }
        if let Some(last) = segments.last_mut() {
            last.bars = None;
        }
        let first = Plan { bars: None, bpm: segments[0].bpm, sig: sig.clone(), label: String::new() };
        let origin = beats[0];
        let mut map = Self::with_count_in(segments, &first, count_in_bars, origin);
        // Same unit as the click track (not eighths), whatever the time signature.
        if let Some(c) = map.segments.first_mut().filter(|s| s.count_in) {
            c.compound = false;
            c.beats = bpb as u32;
            c.beat = 60.0 / first.bpm;
            map.count_in = c.beat * bpb as f64 * count_in_bars as f64;
            c.start = origin - map.count_in;
            map.pre_roll = (map.count_in - origin).max(0.0);
        }
        map
    }

    /// Grid warped by hand: constant tempo between two anchors, the nearest
    /// interval's tempo before the first and after the last one (`bpm` when
    /// there is a single anchor). Labelled sections start new segments.
    pub fn from_anchors(
        anchors: &[Anchor],
        bpm: Option<f64>,
        time_sig: Option<&str>,
        count_in_bars: u32,
        sections: &[SectionSpec],
    ) -> Self {
        let sig = time_sig.filter(|s| !s.trim().is_empty()).unwrap_or("4/4").to_string();
        let compound = is_compound(&sig);
        let (bpb, _) = parse_sig(&sig);
        let unit = |bpm: f64| if compound { 60.0 / bpm / 3.0 } else { 60.0 / bpm };
        let mut sorted = anchors.to_vec();
        sorted.sort_by_key(|a| a.beat);
        let mut pts: Vec<Anchor> = Vec::new();
        for a in sorted {
            // Time must grow with the beats: an anchor out of order is ignored.
            if pts.last().is_some_and(|p| p.beat == a.beat || p.t >= a.t) {
                continue;
            }
            pts.push(a);
        }
        let fallback = unit(bpm.filter(|b| *b > 0.0).unwrap_or(120.0));
        // Seconds per click from anchor i; the last interval goes on forever.
        let rate = |i: usize| -> f64 {
            if pts.len() < 2 {
                return fallback;
            }
            let i = i.min(pts.len() - 2);
            (pts[i + 1].t - pts[i].t) / (pts[i + 1].beat - pts[i].beat) as f64
        };
        let time_of = |beat: u32| -> f64 {
            if pts.is_empty() {
                return beat as f64 * fallback;
            }
            let i = pts.iter().rposition(|p| p.beat <= beat).unwrap_or(0);
            let p = pts[i];
            p.t + (beat as f64 - p.beat as f64) * rate(i)
        };
        // Segment boundaries: bar 1, every anchor, every labelled section.
        let mut labels = Vec::new();
        let mut at = 0u32;
        for s in sections {
            if let Some(l) = s.label.as_ref().filter(|l| !l.is_empty()) {
                labels.push((at * bpb, l.clone()));
            }
            at += s.bars.unwrap_or(0.0).max(0.0) as u32;
        }
        let mut cuts: Vec<u32> = std::iter::once(0)
            .chain(pts.iter().map(|p| p.beat))
            .chain(labels.iter().map(|(b, _)| *b))
            .collect();
        cuts.sort_unstable();
        cuts.dedup();
        let segments: Vec<Segment> = cuts
            .iter()
            .enumerate()
            .map(|(i, &b)| {
                let next = cuts.get(i + 1).copied();
                let start = time_of(b);
                let beat = match next {
                    Some(n) => (time_of(n) - start) / (n - b) as f64,
                    None => rate(usize::MAX),
                };
                Segment {
                    start,
                    beat,
                    beats: bpb,
                    compound,
                    bars: None,
                    bpm: if compound { 60.0 / beat / 3.0 } else { 60.0 / beat },
                    time_sig: sig.clone(),
                    label: labels.iter().find(|(lb, _)| *lb == b).map(|(_, l)| l.clone()).unwrap_or_default(),
                    first_bar: (b / bpb) as i64 + 1,
                    first_beat: b % bpb,
                    clicks: next.map(|n| n - b),
                    count_in: false,
                }
            })
            .collect();
        let first = Plan { bars: None, bpm: segments[0].bpm, sig, label: String::new() };
        let origin = segments[0].start;
        Self::with_count_in(segments, &first, count_in_bars, origin)
    }

    pub fn from_sync(
        sync: Option<&SyncSpec>,
        bpm: Option<f64>,
        time_sig: Option<&str>,
        count_in_bars: u32,
        sections: &[SectionSpec],
    ) -> Self {
        match sync {
            Some(SyncSpec::Beats { beats, beats_per_bar }) if beats.len() >= 2 => {
                Self::from_beats(beats, *beats_per_bar, time_sig, count_in_bars, sections)
            }
            Some(SyncSpec::Anchors { anchors, bpm: manual }) if !anchors.is_empty() => {
                Self::from_anchors(anchors, manual.or(bpm), time_sig, count_in_bars, sections)
            }
            Some(SyncSpec::Offset { origin, bpm: detected }) => {
                Self::build_at(detected.or(bpm), time_sig, count_in_bars, sections, *origin)
            }
            _ => Self::build(bpm, time_sig, count_in_bars, sections),
        }
    }

    fn with_count_in(mut segments: Vec<Segment>, first: &Plan, count_in_bars: u32, origin: f64) -> Self {
        let mut count_in = 0.0;
        if count_in_bars > 0 {
            let seg = segment(first, 0.0, -(count_in_bars as i64), true, Some(count_in_bars));
            count_in = seg.beat * seg.beats as f64 * count_in_bars as f64;
            segments.insert(0, Segment { start: origin - count_in, ..seg });
        }
        Self { segments, count_in, origin, pre_roll: (count_in - origin).max(0.0) }
    }

    fn segment_at(&self, t: f64) -> &Segment {
        self.segments.iter().rev().find(|s| s.start <= t).unwrap_or(&self.segments[0])
    }

    /// Bar (1-based, negative in the count-in), beat (1-based) and beats per bar at time t.
    pub fn position(&self, t: f64) -> (i64, u32, u32) {
        let s = self.segment_at(t);
        // A hair of tolerance: a time computed on a beat must not fall just before it.
        let k = ((t - s.start) / s.beat + 1e-9).floor().max(0.0) as i64 + s.first_beat as i64;
        let beats = s.beats as i64;
        (s.first_bar + k / beats, (k % beats) as u32 + 1, s.beats)
    }

    /// Sample-accurate view of the map for the audio thread.
    pub fn frames(&self, sample_rate: u32) -> TempoFrames {
        let sr = sample_rate as f64;
        TempoFrames {
            segs: self
                .segments
                .iter()
                .map(|s| SegFrames {
                    start: s.start * sr,
                    beat: s.beat * sr,
                    beats: s.beats as u64,
                    compound: s.compound,
                    clicks: s.clicks.map(u64::from).or(s.bars.map(|b| b as u64 * s.beats as u64)),
                    first_beat: s.first_beat as u64,
                    count_in: s.count_in,
                })
                .collect(),
        }
    }
}

pub struct SegFrames {
    start: f64,
    beat: f64,
    beats: u64,
    compound: bool,
    clicks: Option<u64>,
    first_beat: u64,
    count_in: bool,
}

pub struct TempoFrames {
    segs: Vec<SegFrames>,
}

impl TempoFrames {
    /// Calls `f(frame, kind, in_count_in)` for each click in [from, to). No allocations.
    pub fn clicks_in(&self, from: i64, to: i64, mut f: impl FnMut(i64, ClickKind, bool)) {
        let (from_f, to_f) = (from as f64, to as f64);
        for s in &self.segs {
            let end = s.clicks.map_or(f64::INFINITY, |n| s.start + n as f64 * s.beat);
            if end <= from_f || s.start >= to_f {
                continue;
            }
            let mut k = ((from_f - s.start) / s.beat).ceil().max(0.0) as u64;
            loop {
                if s.clicks.is_some_and(|n| k >= n) {
                    break;
                }
                let t = s.start + k as f64 * s.beat;
                if t >= to_f {
                    break;
                }
                let i = (k + s.first_beat) % s.beats;
                let kind = if s.count_in {
                    if i == 0 { ClickKind::Accent } else { ClickKind::Count }
                } else if i == 0 {
                    ClickKind::Accent
                } else if s.compound && i % 3 == 0 {
                    ClickKind::Group
                } else {
                    ClickKind::Beat
                };
                f(t.floor() as i64, kind, s.count_in);
                k += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_in_and_sections() {
        let sections = vec![
            SectionSpec { label: Some("Intro".into()), bars: Some(2.0), bpm: Some(120.0), time_sig: Some("4/4".into()) },
            SectionSpec { label: Some("Strofa".into()), bars: Some(4.0), bpm: Some(60.0), time_sig: Some("3/4".into()) },
        ];
        let map = TempoMap::build(Some(120.0), Some("4/4"), 1, &sections);
        assert_eq!(map.segments.len(), 3);
        assert!((map.count_in - 2.0).abs() < 1e-9);
        assert!((map.pre_roll - 2.0).abs() < 1e-9);
        assert_eq!(map.position(-2.0), (-1, 1, 4));
        assert_eq!(map.position(0.0), (1, 1, 4));
        // Intro: 2 bars of 4/4 at 120 = 4 s, then 3/4 at 60.
        assert_eq!(map.position(4.0), (3, 1, 3));
        assert_eq!(map.position(6.0), (3, 3, 3));

        let frames = map.frames(1000);
        let mut clicks = Vec::new();
        frames.clicks_in(-2000, 1, |f, k, c| clicks.push((f, k, c)));
        assert_eq!(clicks.len(), 5);
        assert_eq!(clicks[0], (-2000, ClickKind::Accent, true));
        assert_eq!(clicks[1], (-1500, ClickKind::Count, true));
        assert_eq!(clicks[4], (0, ClickKind::Accent, false));
    }

    #[test]
    fn compound_meter_clicks_eighths() {
        let map = TempoMap::build(Some(60.0), Some("6/8"), 0, &[]);
        let frames = map.frames(300);
        let mut kinds = Vec::new();
        frames.clicks_in(0, 600, |_, k, _| kinds.push(k));
        // 60 BPM dotted quarter = 3 clicks per second, 6 per bar.
        assert_eq!(kinds.len(), 6);
        assert_eq!(kinds[0], ClickKind::Accent);
        assert_eq!(kinds[3], ClickKind::Group);
    }

    #[test]
    fn offset_moves_bar_one_and_count_in() {
        let map = TempoMap::build_at(Some(120.0), Some("4/4"), 1, &[], 3.0);
        assert!((map.origin - 3.0).abs() < 1e-9);
        // The count-in (2 s) fits in the 3 s before bar 1: no pre-roll.
        assert!(map.pre_roll.abs() < 1e-9);
        assert_eq!(map.position(3.0), (1, 1, 4));
        assert_eq!(map.position(1.0), (-1, 1, 4));
    }

    #[test]
    fn beats_follow_tempo_changes() {
        // 2 bars of 4 at 0.5 s, then 4 beats at 0.4 s, bar 1 at 1.0 s.
        let mut beats = Vec::new();
        let mut t = 1.0;
        for i in 0..12 {
            beats.push(t);
            t += if i < 8 { 0.5 } else { 0.4 };
        }
        let sections = vec![SectionSpec { label: Some("Intro".into()), bars: Some(2.0), ..Default::default() }, SectionSpec { label: Some("Strofa".into()), ..Default::default() }];
        let map = TempoMap::from_beats(&beats, 4, Some("4/4"), 1, &sections);
        assert_eq!(map.position(1.0), (1, 1, 4));
        assert_eq!(map.position(5.0), (3, 1, 4));
        assert_eq!(map.position(5.45), (3, 2, 4));
        let labels: Vec<_> = map.segments.iter().filter(|s| !s.label.is_empty()).map(|s| (s.first_bar, s.label.clone())).collect();
        assert_eq!(labels, vec![(-1, "Count-in".to_string()), (1, "Intro".to_string()), (3, "Strofa".to_string())]);
        // 1 bar of count-in at 120 BPM (2 s) needs 1 s before the audio.
        assert!((map.pre_roll - 1.0).abs() < 1e-9);
        let frames = map.frames(100);
        let mut clicks = Vec::new();
        frames.clicks_in(500, 640, |f, _, _| clicks.push(f));
        assert_eq!(clicks, vec![500, 540, 580, 620]);
    }

    #[test]
    fn anchors_warp_the_grid() {
        // Bar 1 at 1.0 s; beat 6 (bar 2, beat 3) at 4.0 s; beat 12 at 6.4 s.
        let anchors = [Anchor { beat: 0, t: 1.0 }, Anchor { beat: 6, t: 4.0 }, Anchor { beat: 12, t: 6.4 }];
        let map = TempoMap::from_anchors(&anchors, Some(100.0), Some("4/4"), 0, &[]);
        assert!((map.origin - 1.0).abs() < 1e-9);
        assert_eq!(map.position(1.0), (1, 1, 4));
        // 0.5 s per beat up to beat 6, then 0.4 s.
        assert_eq!(map.position(3.0), (2, 1, 4));
        assert_eq!(map.position(4.0), (2, 3, 4));
        assert_eq!(map.position(4.45), (2, 4, 4));
        assert_eq!(map.position(4.8), (3, 1, 4));
        // After the last anchor the last tempo goes on.
        assert_eq!(map.position(6.4 + 0.4 * 4.0), (5, 1, 4));
        let frames = map.frames(100);
        let mut clicks = Vec::new();
        frames.clicks_in(300, 500, |f, k, _| clicks.push((f, k)));
        assert_eq!(
            clicks,
            vec![(300, ClickKind::Accent), (350, ClickKind::Beat), (400, ClickKind::Beat), (440, ClickKind::Beat), (480, ClickKind::Accent)]
        );
    }

    #[test]
    fn single_anchor_shifts_with_manual_tempo() {
        // Beat 4 (bar 2) pinned at 3.0 s, 120 BPM: bar 1 at 1.0 s.
        let map = TempoMap::from_anchors(&[Anchor { beat: 4, t: 3.0 }], Some(120.0), Some("4/4"), 1, &[]);
        assert!((map.origin - 1.0).abs() < 1e-9);
        assert_eq!(map.position(3.0), (2, 1, 4));
        assert!((map.pre_roll - 1.0).abs() < 1e-9);
    }
}
