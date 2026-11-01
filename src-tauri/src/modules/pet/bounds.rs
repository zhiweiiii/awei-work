pub(super) fn anchor(
    position: (i32, i32),
    previous: (u32, u32),
    next: (u32, u32),
    work_area: Option<(i32, i32, u32, u32)>,
) -> (i32, i32) {
    let mut x = i64::from(position.0) + i64::from(previous.0) - i64::from(next.0);
    let mut y = i64::from(position.1) + i64::from(previous.1) - i64::from(next.1);
    if let Some((left, top, width, height)) = work_area {
        let left = i64::from(left);
        let top = i64::from(top);
        x = x.clamp(
            left,
            (left + i64::from(width) - i64::from(next.0)).max(left),
        );
        y = y.clamp(top, (top + i64::from(height) - i64::from(next.1)).max(top));
    }
    (
        x.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
        y.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32,
    )
}

#[cfg(windows)]
pub(super) fn apply(
    hwnd: windows_sys::Win32::Foundation::HWND,
    position: (i32, i32),
    size: (u32, u32),
) -> Result<(), String> {
    use windows_sys::Win32::Foundation::RECT;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
    };
    if hwnd.is_null() || size.0 == 0 || size.1 == 0 {
        return Err("invalid pet window bounds".into());
    }
    let width = i32::try_from(size.0).map_err(|_| "pet window too wide")?;
    let height = i32::try_from(size.1).map_err(|_| "pet window too tall")?;
    unsafe {
        let mut current = RECT::default();
        if GetWindowRect(hwnd, &mut current) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if current.left == position.0
            && current.top == position.1
            && i64::from(current.right) - i64::from(current.left) == i64::from(width)
            && i64::from(current.bottom) - i64::from(current.top) == i64::from(height)
        {
            return Ok(());
        }
        if SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            position.0,
            position.1,
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        ) == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}
