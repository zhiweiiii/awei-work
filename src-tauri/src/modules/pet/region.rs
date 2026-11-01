use super::layout::{Layout, Rect, CANVAS_HEIGHT, CANVAS_WIDTH};
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Graphics::Gdi::{
    CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR,
};

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Shape(Vec<(i32, i32, i32, i32)>);

impl Shape {
    pub(super) fn new(layout: &Layout, scale: f64) -> Result<Self, String> {
        if !scale.is_finite() || scale <= 0.0 {
            return Err("invalid pet scale".into());
        }
        let pixel = |rect: Rect, padding: f64| {
            (
                ((rect.x - padding).max(0.0) * scale).floor() as i32,
                ((rect.y - padding).max(0.0) * scale).floor() as i32,
                ((rect.x + rect.width + padding).min(CANVAS_WIDTH) * scale).ceil() as i32,
                ((rect.y + rect.height + padding).min(CANVAS_HEIGHT) * scale).ceil() as i32,
            )
        };
        let mut rectangles = vec![pixel(layout.icon, 0.0)];
        if let Some(bubble) = layout.bubble {
            rectangles.push(pixel(bubble, 8.0));
        }
        Ok(Self(rectangles))
    }
}

pub(super) fn apply(hwnd: HWND, shape: &Shape) -> Result<(), String> {
    if hwnd.is_null() {
        return Err("invalid pet window".into());
    }
    unsafe {
        let combined = CreateRectRgn(0, 0, 0, 0);
        if combined.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        for &(left, top, right, bottom) in &shape.0 {
            let rectangle = CreateRectRgn(left, top, right, bottom);
            if rectangle.is_null() {
                let error = std::io::Error::last_os_error().to_string();
                DeleteObject(combined);
                return Err(error);
            }
            let result = CombineRgn(combined, combined, rectangle, RGN_OR);
            DeleteObject(rectangle);
            if result == 0 {
                DeleteObject(combined);
                return Err("could not combine pet window regions".into());
            }
        }
        if SetWindowRgn(hwnd, combined, 0) == 0 {
            let error = std::io::Error::last_os_error().to_string();
            DeleteObject(combined);
            return Err(error);
        }
    }
    Ok(())
}
