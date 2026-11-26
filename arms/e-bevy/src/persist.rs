//! Tiny save file for the best lap time.
//!
//! * macOS: `~/Library/Application Support/ApexRush/save.json`
//! * iOS:   `<app sandbox>/Documents/save.json` (`$HOME` is the sandbox there)
//! * other: `$XDG_DATA_HOME/apex-rush/save.json` or `~/.local/share/apex-rush/save.json`
//!
//! `RACER_SAVE_DIR` overrides the directory (used by tests).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Default, Debug, Clone, PartialEq)]
pub struct SaveData {
    pub best_lap_s: Option<f32>,
}

pub fn save_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("RACER_SAVE_DIR") {
        return Some(PathBuf::from(dir));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    if cfg!(target_os = "ios") {
        Some(home.join("Documents"))
    } else if cfg!(target_os = "macos") {
        Some(home.join("Library/Application Support/ApexRush"))
    } else if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        Some(PathBuf::from(xdg).join("apex-rush"))
    } else {
        Some(home.join(".local/share/apex-rush"))
    }
}

fn save_path() -> Option<PathBuf> {
    save_dir().map(|d| d.join("save.json"))
}

pub fn load() -> SaveData {
    save_path().map(|p| load_from(&p)).unwrap_or_default()
}

pub fn store(data: &SaveData) -> std::io::Result<()> {
    match save_path() {
        Some(p) => store_to(&p, data),
        None => Err(std::io::Error::other("no save directory")),
    }
}

pub fn load_from(path: &Path) -> SaveData {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn store_to(path: &Path, data: &SaveData) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // Write-then-rename so a crash never leaves a truncated file.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(data)?)?;
    std::fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_missing_file() {
        let dir = std::env::temp_dir().join(format!("racer-save-test-{}", std::process::id()));
        let path = dir.join("nested/save.json");
        assert_eq!(load_from(&path), SaveData::default());
        let data = SaveData {
            best_lap_s: Some(61.25),
        };
        store_to(&path, &data).unwrap();
        assert_eq!(load_from(&path), data);
        std::fs::remove_dir_all(dir).ok();
    }
}
