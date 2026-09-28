const BUNDLED_FFMPEG_PATH_ENV: &str = "VIDEORC_BUNDLED_FFMPEG_PATH";
const BUNDLED_FFPROBE_PATH_ENV: &str = "VIDEORC_BUNDLED_FFPROBE_PATH";

pub fn default_ffmpeg_path() -> String {
    std::env::var(BUNDLED_FFMPEG_PATH_ENV)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "ffmpeg".to_string())
}

/// Resolves the FFprobe binary that pairs with an already-resolved FFmpeg path: an
/// explicit `VIDEORC_BUNDLED_FFPROBE_PATH` wins, otherwise a sibling `ffprobe` next to a
/// bundled `ffmpeg` (or `ffprobe.exe` beside `ffmpeg.exe`) is derived, otherwise
/// it falls back to `ffprobe` on `PATH`.
pub fn ffprobe_path_for(ffmpeg_path: &str) -> String {
    paired_ffprobe_path(
        ffmpeg_path,
        std::env::var(BUNDLED_FFPROBE_PATH_ENV).ok().as_deref(),
    )
}

fn paired_ffprobe_path(ffmpeg_path: &str, explicit: Option<&str>) -> String {
    if let Some(explicit) = explicit.map(str::trim).filter(|path| !path.is_empty()) {
        return explicit.to_string();
    }
    let ffmpeg_path = ffmpeg_path.trim();
    if let Some(prefix) = ffmpeg_path.strip_suffix("ffmpeg.exe") {
        return format!("{prefix}ffprobe.exe");
    }
    if let Some(prefix) = ffmpeg_path.strip_suffix("ffmpeg") {
        return format!("{prefix}ffprobe");
    }
    "ffprobe".to_string()
}

pub fn resolve_ffmpeg_path(path: Option<String>) -> String {
    path.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(default_ffmpeg_path)
}

pub fn resolve_ffmpeg_path_ref(path: Option<&str>) -> String {
    path.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(default_ffmpeg_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_sibling_ffprobe_next_to_bundled_ffmpeg() {
        // Only meaningful when the explicit override env is unset (the common case).
        if std::env::var("VIDEORC_BUNDLED_FFPROBE_PATH").is_ok() {
            return;
        }
        assert_eq!(ffprobe_path_for("/opt/ff/ffmpeg"), "/opt/ff/ffprobe");
        assert_eq!(ffprobe_path_for("ffmpeg"), "ffprobe");
    }

    #[test]
    fn derives_windows_sibling_ffprobe_without_host_path_semantics() {
        assert_eq!(
            paired_ffprobe_path(r"D:\Videorc tools\bin\ffmpeg.exe", None),
            r"D:\Videorc tools\bin\ffprobe.exe"
        );
        assert_eq!(paired_ffprobe_path("ffmpeg.exe", None), "ffprobe.exe");
        assert_eq!(
            paired_ffprobe_path(r"D:\bin\ffmpeg.exe", Some(r" E:\tools\probe.exe ")),
            r"E:\tools\probe.exe"
        );
    }

    #[test]
    fn falls_back_to_ffprobe_for_unrecognized_ffmpeg_path() {
        if std::env::var("VIDEORC_BUNDLED_FFPROBE_PATH").is_ok() {
            return;
        }
        assert_eq!(ffprobe_path_for("/opt/custom/ffmpeg-static"), "ffprobe");
    }
}
