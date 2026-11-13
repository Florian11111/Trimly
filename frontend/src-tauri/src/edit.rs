//! Editor export of the desktop app: counterpart of backend/app/video/EditRenderer.scala.
//! Pure logic (validation, building ffmpeg arguments) without processes, so everything is testable.
//! The project comes from `buildRenderProject` in the frontend; here `originalId` is the file path.

use crate::ffmpeg::{encoder_args, final_format_filter, hw_init_args, pix_fmt_args, Crop, AUDIO_ONLY_KBPS};
use serde::Deserialize;
use std::collections::HashMap;

/// Like VideoCalculator.AudioBitrateKbps in the backend
const AUDIO_KBPS: u32 = 128;
/// Duration of the smooth zoom in/out in seconds
const ZOOM_RAMP: f64 = 0.3;

#[derive(Deserialize, Debug, Clone)]
pub struct EditPreset {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    /// kbit/s
    pub bitrate: u32,
}

/// Video track: segments play one after another
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EditVideoSeg {
    pub original_id: String,
    pub start: f64,
    pub end: f64,
    /// Playback speed, 0.25–4 (missing = 1)
    #[serde(default = "one")]
    pub speed: f64,
}

fn one() -> f64 {
    1.0
}

/// Speed limits as in the editor (`SPEEDS` in project.js)
const MIN_SPEED: f64 = 0.25;
const MAX_SPEED: f64 = 4.0;

/// Audio track: segments are placed freely on the timeline (at = start time in the output)
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct EditAudioSeg {
    pub original_id: String,
    pub start: f64,
    pub end: f64,
    pub at: f64,
    pub volume: f64,
    #[serde(default = "one")]
    pub speed: f64,
}

/// Zoom into the area x,y (top left) with width w; the height follows from the aspect ratio
#[derive(Deserialize, Debug, Clone)]
pub struct EditZoom {
    pub start: f64,
    pub end: f64,
    pub x: f64,
    pub y: f64,
    pub w: f64,
}

/// Overlay = transparent PNG in output size (the UI draws arrows, text and images)
#[derive(Deserialize, Debug, Clone)]
pub struct EditOverlay {
    pub file: String,
    pub start: f64,
    pub end: f64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct EditProject {
    pub preset: EditPreset,
    pub video: Vec<EditVideoSeg>,
    #[serde(default)]
    pub audio: Vec<EditAudioSeg>,
    #[serde(default)]
    pub zooms: Vec<EditZoom>,
    #[serde(default)]
    pub overlays: Vec<EditOverlay>,
    /// "both", "video" (no audio) or "audio" (audio only, as MP3)
    #[serde(default = "default_output")]
    pub output: String,
    /// Free crop of the output frame (relative, 0..1); the result gets smaller accordingly
    #[serde(default)]
    pub crop: Option<Crop>,
}

fn default_output() -> String {
    "both".into()
}

impl EditProject {
    /// Length of the video track in seconds
    pub fn total(&self) -> f64 {
        self.video.iter().map(|s| (s.end - s.start) / s.speed).sum()
    }

    /// Length of the audio track (end of the last audio segment)
    pub fn audio_total(&self) -> f64 {
        self.audio.iter().map(|s| s.at + (s.end - s.start) / s.speed).fold(0.0, f64::max)
    }
}

/// Numbers without exponent notation, at most 4 decimals
fn num(v: f64) -> String {
    let s = format!("{v:.4}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

/// Validates the project; `overlay_files` maps overlay names to their PNG files.
pub fn validate(p: &EditProject, overlay_files: &HashMap<String, String>) -> Result<(), String> {
    let err = |m: &str| Err(m.to_string());
    if p.video.is_empty() {
        return err("The video track is empty.");
    }
    if p.video.iter().any(|s| s.start < 0.0 || s.end - s.start < 0.005) {
        return err("A video clip is invalid.");
    }
    let bad_speed = |v: f64| !(MIN_SPEED..=MAX_SPEED).contains(&v);
    if p.video.iter().any(|s| bad_speed(s.speed)) || p.audio.iter().any(|s| bad_speed(s.speed)) {
        return err("The speed has to be between 0.25× and 4×.");
    }
    if p.audio.iter().any(|s| s.start < 0.0 || s.end - s.start < 0.005 || s.at < 0.0 || s.volume < 0.0) {
        return err("An audio clip is invalid.");
    }
    if p.zooms.iter().any(|z| {
        z.end <= z.start || z.w <= 0.0 || z.w > 1.0 || z.x < 0.0 || z.y < 0.0 || z.x + z.w > 1.001 || z.y + z.w > 1.001
    }) {
        return err("A zoom area is invalid.");
    }
    if p.overlays.iter().any(|o| o.end <= o.start || !overlay_files.contains_key(&o.file)) {
        return err("An overlay is invalid.");
    }
    if p.preset.width < 16 || p.preset.height < 16 || p.preset.fps <= 0.0 || p.preset.bitrate == 0 {
        return err("The export settings are invalid.");
    }
    if p.total() > 6.0 * 3600.0 {
        return err("The project is too long (6 hours at most).");
    }
    if p.crop.is_some_and(|c| !c.valid()) {
        return err("The crop area is invalid.");
    }
    if !["both", "video", "audio"].contains(&p.output.as_str()) {
        return err("The output format is invalid.");
    }
    Ok(())
}

/// Collects inputs and filters for one ffmpeg call.
#[derive(Default)]
struct Graph {
    inputs: Vec<String>,
    filters: Vec<String>,
    count: usize,
}

impl Graph {
    fn input(&mut self, args: &[&str]) -> usize {
        self.inputs.extend(args.iter().map(|s| s.to_string()));
        self.count += 1;
        self.count - 1
    }
}

/// Adds the audio inputs and the mix [aout]; false if no segment has audio.
fn add_audio(p: &EditProject, total: f64, has_audio: &dyn Fn(&str) -> bool, g: &mut Graph) -> bool {
    let segs: Vec<&EditAudioSeg> =
        p.audio.iter().filter(|s| s.at < total && has_audio(&s.original_id)).collect();
    if segs.is_empty() {
        return false;
    }
    let mut labels = String::new();
    for (i, seg) in segs.iter().enumerate() {
        let idx = g.input(&["-ss", &num(seg.start), "-t", &num(seg.end - seg.start), "-i", &seg.original_id]);
        let delay_ms = (seg.at * 1000.0).round() as i64;
        g.filters.push(format!(
            "[{idx}:a:0]aresample=48000,aformat=channel_layouts=stereo,asetpts=PTS-STARTPTS{},volume={},adelay={delay_ms}:all=1[a{i}]",
            atempo(seg.speed),
            num(seg.volume)
        ));
        labels.push_str(&format!("[a{i}]"));
    }
    g.filters.push(format!("anullsrc=r=48000:cl=stereo,atrim=duration={}[abase]", num(total)));
    g.filters.push(format!(
        "[abase]{labels}amix=inputs={}:duration=first:normalize=0[aout]",
        segs.len() + 1
    ));
    true
}

/// Audio speed as an atempo chain (each link 0.5–2), e.g. 4 → ",atempo=2,atempo=2"; speed 1 → empty
fn atempo(speed: f64) -> String {
    if (speed - 1.0).abs() < 1e-6 {
        return String::new();
    }
    let mut rest = speed;
    let mut out = String::new();
    while rest > 2.0 + 1e-9 {
        out.push_str(",atempo=2");
        rest /= 2.0;
    }
    while rest < 0.5 - 1e-9 {
        out.push_str(",atempo=0.5");
        rest /= 0.5;
    }
    out.push_str(&format!(",atempo={}", num(rest)));
    out
}

fn head() -> Vec<String> {
    ["-hide_banner", "-nostats", "-y", "-progress", "pipe:1", "-v", "error"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// ffmpeg arguments for the video export (without the program name).
/// `source_fps`: highest frame rate of the sources (0 = unknown), `has_audio`: does the file have an audio track?
pub fn build_video_args(
    p: &EditProject,
    overlay_files: &HashMap<String, String>,
    source_fps: f64,
    has_audio: &dyn Fn(&str) -> bool,
    encoder: &str,
    out: &str,
) -> Vec<String> {
    let w = p.preset.width - p.preset.width % 2;
    let h = p.preset.height - p.preset.height % 2;
    // No more fps than the fastest source, otherwise only duplicated frames
    let fps = if source_fps > 0.0 { p.preset.fps.min(source_fps) } else { p.preset.fps };
    let total = p.total();
    let mut g = Graph::default();

    // Video track: each segment on its own (fast seek with -ss before -i), scaled to the output size, concatenated
    let mut labels = String::new();
    for (i, seg) in p.video.iter().enumerate() {
        let idx = g.input(&["-ss", &num(seg.start), "-t", &num(seg.end - seg.start), "-i", &seg.original_id]);
        g.filters.push(format!(
            "[{idx}:v:0]setpts=(PTS-STARTPTS)/{},scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps={},format=yuv420p[v{i}]",
            num(seg.speed),
            num(fps)
        ));
        labels.push_str(&format!("[v{i}]"));
    }
    g.filters.push(format!("{labels}concat=n={}:v=1:a=0[vcat]", p.video.len()));
    let mut current = "[vcat]".to_string();

    // Zoom: factor and centre as a function of time, with a smooth ramp
    if !p.zooms.is_empty() {
        let ramps: Vec<String> = p
            .zooms
            .iter()
            .map(|z| {
                let r = num(ZOOM_RAMP.min((z.end - z.start) / 2.0));
                format!("clip((it-{})/{r},0,1)*clip(({}-it)/{r},0,1)", num(z.start), num(z.end))
            })
            .collect();
        let sum = |base: &str, f: &dyn Fn(&EditZoom) -> f64| {
            base.to_string()
                + &p.zooms.iter().zip(&ramps).map(|(z, r)| format!("+{}*{r}", num(f(z)))).collect::<String>()
        };
        let zoom = sum("1", &|z| 1.0 / z.w - 1.0);
        let cx = sum("0.5", &|z| z.x + z.w / 2.0 - 0.5);
        let cy = sum("0.5", &|z| z.y + z.w / 2.0 - 0.5);
        g.filters.push(format!(
            "{current}zoompan=z='{zoom}':x='clip(({cx})*iw-iw/zoom/2,0,iw-iw/zoom)':y='clip(({cy})*ih-ih/zoom/2,0,ih-ih/zoom)':d=1:s={w}x{h}:fps={}[vzoom]",
            num(fps)
        ));
        current = "[vzoom]".into();
    }

    // Overlays after the zoom, so arrows and text stay where they were drawn
    for (i, o) in p.overlays.iter().enumerate() {
        let idx = g.input(&["-loop", "1", "-i", &overlay_files[&o.file]]);
        g.filters.push(format!("[{idx}:v:0]scale={w}:{h},format=rgba[ov{i}]"));
        g.filters.push(format!(
            "{current}[ov{i}]overlay=0:0:enable='between(t,{},{})':shortest=1[vo{i}]",
            num(o.start),
            num(o.end)
        ));
        current = format!("[vo{i}]");
    }
    // Crop last, so zoom and overlays sit inside the crop just like in the preview
    let crop = p.crop.map(|c| format!("{},", c.filter())).unwrap_or_default();
    g.filters.push(format!("{current}{crop}{}[vout]", final_format_filter(encoder)));

    let with_audio = p.output != "video" && add_audio(p, total, has_audio, &mut g);

    let mut a = head();
    a.extend(hw_init_args(encoder));
    a.extend(g.inputs);
    a.extend(["-filter_complex".into(), g.filters.join(";"), "-map".into(), "[vout]".into()]);
    if with_audio {
        a.extend(["-map", "[aout]", "-c:a", "aac", "-b:a"].iter().map(|s| s.to_string()));
        a.push(format!("{AUDIO_KBPS}k"));
    }
    a.extend(["-c:v".to_string(), encoder.to_string()]);
    a.extend(encoder_args(encoder).iter().map(|s| s.to_string()));
    a.extend(["-b:v".into(), format!("{}k", p.preset.bitrate)]);
    a.extend(pix_fmt_args(encoder).iter().map(|s| s.to_string()));
    a.extend(["-t".into(), num(total), "-movflags".into(), "+faststart".into(), "-f".into(), "mp4".into()]);
    a.push(out.to_string());
    a
}

/// Audio only: the whole audio track (including after the video ends) as MP3. None if the project has no audio.
pub fn build_audio_args(p: &EditProject, has_audio: &dyn Fn(&str) -> bool, out: &str) -> Option<Vec<String>> {
    let total = p.audio_total();
    let mut g = Graph::default();
    if !add_audio(p, total, has_audio, &mut g) {
        return None;
    }
    let mut a = head();
    a.extend(g.inputs);
    a.extend(["-filter_complex".into(), g.filters.join(";"), "-map".into(), "[aout]".into()]);
    a.extend(["-c:a".into(), "libmp3lame".into(), "-b:a".into(), format!("{AUDIO_ONLY_KBPS}k")]);
    a.extend(["-t".into(), num(total), "-f".into(), "mp3".into(), out.to_string()]);
    Some(a)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> EditProject {
        serde_json::from_str(
            r#"{
              "preset": {"width": 1281, "height": 720, "fps": 60, "bitrate": 2500},
              "video": [{"originalId": "a.mp4", "start": 1, "end": 3}, {"originalId": "b.mp4", "start": 0, "end": 2.5}],
              "audio": [{"originalId": "a.mp4", "start": 1, "end": 3, "at": 0, "volume": 1},
                        {"originalId": "b.mp4", "start": 0, "end": 2.5, "at": 2, "volume": 0.5}],
              "zooms": [{"start": 0.5, "end": 1.5, "x": 0.25, "y": 0.25, "w": 0.5}],
              "overlays": [{"file": "overlay_0", "start": 0, "end": 1}]
            }"#,
        )
        .unwrap()
    }

    fn files() -> HashMap<String, String> {
        HashMap::from([("overlay_0".to_string(), "/tmp/o0.png".to_string())])
    }

    #[test]
    fn reads_frontend_project_with_defaults() {
        let p = project();
        assert_eq!(p.output, "both");
        assert_eq!(p.total(), 4.5);
        assert_eq!(p.audio_total(), 4.5);
        assert!(validate(&p, &files()).is_ok());
    }

    #[test]
    fn rejects_missing_overlay_and_empty_video() {
        let p = project();
        assert_eq!(validate(&p, &HashMap::new()).unwrap_err(), "An overlay is invalid.");
        let empty = EditProject { video: vec![], ..project() };
        assert_eq!(validate(&empty, &files()).unwrap_err(), "The video track is empty.");
    }

    #[test]
    fn video_graph_concats_zooms_overlays_and_mixes() {
        let args = build_video_args(&project(), &files(), 30.0, &|_| true, "libx264", "out.mp4");
        let s = args.join(" ");
        let graph = &args[args.iter().position(|a| a == "-filter_complex").unwrap() + 1];
        // an odd width becomes even, fps capped to the source
        assert!(graph.contains("scale=1280:720:force_original_aspect_ratio=decrease"), "{graph}");
        assert!(graph.contains("fps=30,"), "{graph}");
        assert!(graph.contains("[v0][v1]concat=n=2:v=1:a=0[vcat]"), "{graph}");
        assert!(graph.contains("[vcat]zoompan=z='1+1*clip((it-0.5)/0.3,0,1)*clip((1.5-it)/0.3,0,1)'"), "{graph}");
        assert!(graph.contains("[vzoom][ov0]overlay=0:0:enable='between(t,0,1)'"), "{graph}");
        assert!(graph.contains("volume=0.5,adelay=2000:all=1[a1]"), "{graph}");
        assert!(graph.contains("amix=inputs=3:duration=first:normalize=0[aout]"), "{graph}");
        assert!(s.contains("-i /tmp/o0.png"), "{s}");
        assert!(s.contains("-map [aout] -c:a aac -b:a 128k -c:v libx264 -preset veryfast -b:v 2500k"), "{s}");
        assert!(s.ends_with("-t 4.5 -movflags +faststart -f mp4 out.mp4"), "{s}");
    }

    #[test]
    fn video_without_audio_when_output_is_video_or_sources_are_silent() {
        let p = EditProject { output: "video".into(), ..project() };
        assert!(!build_video_args(&p, &files(), 0.0, &|_| true, "libx264", "o.mp4").join(" ").contains("aout"));
        let silent = build_video_args(&project(), &files(), 0.0, &|_| false, "libx264", "o.mp4").join(" ");
        assert!(!silent.contains("aout"), "{silent}");
    }

    #[test]
    fn nvenc_keeps_its_settings_in_the_editor() {
        let s = build_video_args(&project(), &files(), 0.0, &|_| true, "h264_nvenc", "o.mp4").join(" ");
        assert!(s.contains("-c:v h264_nvenc -preset p4 -bf 0"), "{s}");
    }

    #[test]
    fn audio_only_exports_whole_audio_track_as_mp3() {
        let s = build_audio_args(&project(), &|_| true, "o.mp3").unwrap().join(" ");
        assert!(s.contains("-c:a libmp3lame -b:a 192k -t 4.5 -f mp3 o.mp3"), "{s}");
        assert!(build_audio_args(&project(), &|_| false, "o.mp3").is_none());
    }

    #[test]
    fn speed_shortens_the_timeline_and_changes_tempo() {
        let mut p = project();
        p.video[0].speed = 2.0; // 2 s of source → 1 s
        p.audio[0].speed = 4.0; // 2 s of source → 0.5 s
        assert_eq!(p.total(), 3.5);
        assert!(validate(&p, &files()).is_ok());
        let graph = build_video_args(&p, &files(), 30.0, &|_| true, "libx264", "o.mp4").join(" ");
        assert!(graph.contains("[0:v:0]setpts=(PTS-STARTPTS)/2,scale="), "{graph}");
        assert!(graph.contains("[1:v:0]setpts=(PTS-STARTPTS)/1,scale="), "{graph}");
        assert!(graph.contains("asetpts=PTS-STARTPTS,atempo=2,atempo=2,volume=1"), "{graph}");
        assert!(graph.contains("-t 3.5 "), "{graph}");
    }

    #[test]
    fn slow_motion_chains_atempo_and_bad_speeds_are_rejected() {
        assert_eq!(atempo(1.0), "");
        assert_eq!(atempo(0.25), ",atempo=0.5,atempo=0.5");
        assert_eq!(atempo(1.5), ",atempo=1.5");
        let mut p = project();
        p.video[1].speed = 8.0;
        assert!(validate(&p, &files()).unwrap_err().contains("speed"));
    }

    #[test]
    fn crop_comes_last_and_is_checked() {
        let mut p = project();
        p.crop = Some(Crop { x: 0.25, y: 0.0, w: 0.3164, h: 1.0 });
        assert!(validate(&p, &files()).is_ok());
        let graph = build_video_args(&p, &files(), 30.0, &|_| true, "libx264", "o.mp4").join(" ");
        assert!(graph.contains("[vo0]crop=trunc(iw*0.316/2)*2:trunc(ih*1/2)*2:trunc(iw*0.25):trunc(ih*0),format=yuv420p[vout]"), "{graph}");
        p.crop = Some(Crop { x: 0.9, y: 0.0, w: 0.5, h: 1.0 });
        assert_eq!(validate(&p, &files()).unwrap_err(), "The crop area is invalid.");
    }
}