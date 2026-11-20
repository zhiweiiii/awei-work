use serde::Deserialize;
use std::path::Path;

use super::layout::{CANVAS_HEIGHT, CANVAS_WIDTH, ICON};

#[derive(Clone, Copy, Debug)]
pub(super) struct Anchor {
    x: i64,
    y: i64,
}

impl Anchor {
    pub(super) fn from_origin(position: (i32, i32), scale: f64) -> Self {
        Self {
            x: i64::from(position.0) + (ICON.x * scale).round() as i64,
            y: i64::from(position.1) + (ICON.y * scale).round() as i64,
        }
    }

    pub(super) fn origin(self, scale: f64) -> (i32, i32) {
        let coordinate = |anchor: i64, offset: f64| {
            (anchor - (offset * scale).round() as i64)
                .clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
        };
        (coordinate(self.x, ICON.x), coordinate(self.y, ICON.y))
    }
}

#[derive(Deserialize)]
struct SavedWindow {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

pub(super) fn load(path: &Path) -> Result<Option<Anchor>, String> {
    let content = match std::fs::read(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let states: serde_json::Value =
        serde_json::from_slice(&content).map_err(|error| error.to_string())?;
    let Some(saved) = states.get(super::STATE_LABEL) else {
        return Ok(None);
    };
    let saved: SavedWindow =
        serde_json::from_value(saved.clone()).map_err(|error| error.to_string())?;
    let scale = if saved.height > 0 {
        f64::from(saved.height) / CANVAS_HEIGHT
    } else if saved.width > 0 {
        f64::from(saved.width) / CANVAS_WIDTH
    } else {
        return Ok(None);
    };
    Ok(Some(Anchor::from_origin((saved.x, saved.y), scale)))
}
