use serde::Serialize;

pub(super) const CANVAS_WIDTH: f64 = 796.0;
pub(super) const CANVAS_HEIGHT: f64 = 1000.0;
pub(super) const ICON: Rect = Rect {
    x: 360.0,
    y: 452.0,
    width: 76.0,
    height: 96.0,
};

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Mode {
    Compact,
    Notice,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layout {
    pub(super) revision: u64,
    pub(super) mode: Mode,
    pub(super) icon: Rect,
    pub(super) bubble: Option<Rect>,
    pub(super) below: bool,
    pub(super) tail: f64,
}

pub(super) fn arrange(mode: Mode, origin: (f64, f64), work: Rect, revision: u64) -> Layout {
    let mut layout = Layout {
        revision,
        mode,
        icon: ICON,
        bubble: None,
        below: false,
        tail: 0.0,
    };
    if mode == Mode::Compact {
        return layout;
    }
    let width = 312.0_f64.min((work.width - 8.0).max(1.0));
    let height = 98.0;
    let above = (origin.1 + ICON.y - work.y - 10.0).max(0.0);
    let below = (work.y + work.height - origin.1 - ICON.y - ICON.height - 10.0).max(0.0);
    let down = above < height && below > above;
    let height = height.min(if down { below } else { above }).max(1.0);
    let left = (origin.0 + ICON.x + ICON.width - width).clamp(
        work.x + 4.0,
        (work.x + work.width - 4.0 - width).max(work.x + 4.0),
    );
    let top = if down {
        origin.1 + ICON.y + ICON.height + 10.0
    } else {
        origin.1 + ICON.y - 10.0 - height
    };
    layout.bubble = Some(Rect {
        x: left - origin.0,
        y: top - origin.1,
        width,
        height,
    });
    layout.below = down;
    let end = (width - 12.0).max(0.0);
    let inset = 8.0_f64.min(end / 2.0);
    layout.tail = (ICON.x + ICON.width / 2.0 - (left - origin.0) - 6.0).clamp(inset, end - inset);
    layout
}

#[cfg(windows)]
pub(super) fn work_area(center: (i32, i32)) -> Result<(i32, i32, i32, i32), String> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromPoint, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    unsafe {
        let monitor = MonitorFromPoint(
            POINT {
                x: center.0,
                y: center.1,
            },
            MONITOR_DEFAULTTONEAREST,
        );
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if monitor.is_null() || GetMonitorInfoW(monitor, &mut info) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok((
            info.rcWork.left,
            info.rcWork.top,
            info.rcWork.right,
            info.rcWork.bottom,
        ))
    }
}
