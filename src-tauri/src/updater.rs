use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

const REPO_API_LATEST: &str = "https://api.github.com/repos/qianyiai/kurocat/releases/latest";
const REPO_RELEASES_PAGE: &str = "https://github.com/qianyiai/kurocat/releases/latest";

pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub release_url: String,
    pub notes_summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgressEvent {
    pub stage: String,
    pub message: String,
    pub info: Option<UpdateInfo>,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: Option<String>,
    body: Option<String>,
}

pub fn parse_semver(raw: &str) -> (u64, u64, u64) {
    let clean = raw.trim().trim_start_matches(['v', 'V']);
    let main = clean.split('-').next().unwrap_or(clean);
    let mut parts = main.split('.');
    let major = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    let minor = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    (major, minor, patch)
}

pub fn is_newer_version(latest: &str, current: &str) -> bool {
    parse_semver(latest) > parse_semver(current)
}

fn summarize_notes(body: Option<&str>) -> String {
    let Some(raw) = body else {
        return String::new();
    };
    raw.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .take(3)
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(180)
        .collect()
}

#[cfg(any(windows, test))]
fn parse_http_url(url: &str) -> Result<(bool, String, u16, String), String> {
    let (is_https, rest) = if let Some(r) = url.strip_prefix("https://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("http://") {
        (false, r)
    } else {
        return Err(format!("不支持的更新地址协议: {}", url));
    };

    let (authority, path_and_query) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    if authority.is_empty() {
        return Err("更新地址缺少主机名".to_string());
    }

    let default_port = if is_https { 443 } else { 80 };
    let (host, port) = if let Some(colon) = authority.rfind(':') {
        let port_str = &authority[colon + 1..];
        if let Ok(p) = port_str.parse::<u16>() {
            (&authority[..colon], p)
        } else {
            (authority, default_port)
        }
    } else {
        (authority, default_port)
    };

    Ok((
        is_https,
        host.to_string(),
        port,
        path_and_query.to_string(),
    ))
}

/// Compact pure-Rust FIPS 180-4 SHA-256 hasher (zero external crate overhead, zero PowerShell).
#[cfg(windows)]
mod winhttp_client {
    use super::parse_http_url;
    use std::ffi::c_void;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::Networking::WinHttp::{
        WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest,
        WinHttpQueryDataAvailable, WinHttpQueryHeaders, WinHttpReadData, WinHttpReceiveResponse,
        WinHttpSendRequest, WinHttpSetOption, WinHttpSetTimeouts,
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_ACCESS_TYPE_DEFAULT_PROXY, WINHTTP_FLAG_SECURE,
        WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2, WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3,
        WINHTTP_OPTION_SECURE_PROTOCOLS, WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_STATUS_CODE,
    };

    struct Handle(*mut c_void);

    impl Drop for Handle {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let _ = WinHttpCloseHandle(self.0);
                }
            }
        }
    }

    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Performs a native WinHTTP GET request (no PowerShell / curl child process),
    /// streaming response chunks into `on_chunk`. Supports Win7 SP1 through Win11
    /// and honors system / PAC proxies automatically.
    pub fn get_stream(
        url: &str,
        user_agent: &str,
        extra_headers: Option<&str>,
        receive_timeout_ms: i32,
        mut on_chunk: impl FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<(), String> {
        let (is_https, host, port, path) = parse_http_url(url)?;
        let ua_w = to_wide(user_agent);

        // Win8.1/10/11: AUTOMATIC_PROXY reads user IE/system proxy & PAC automatically.
        // Win7 SP1 fallback: DEFAULT_PROXY.
        let session_raw = unsafe {
            let h = WinHttpOpen(
                ua_w.as_ptr(),
                WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
                null(),
                null(),
                0,
            );
            if !h.is_null() {
                h
            } else {
                WinHttpOpen(
                    ua_w.as_ptr(),
                    WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
                    null(),
                    null(),
                    0,
                )
            }
        };
        if session_raw.is_null() {
            let err = unsafe { GetLastError() };
            return Err(format!("初始化 WinHTTP 会话失败 (错误码 {})", err));
        }
        let session = Handle(session_raw);

        unsafe {
            let _ = WinHttpSetTimeouts(session.0, 15_000, 15_000, 30_000, receive_timeout_ms);
            let mut protocols =
                WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2 | WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
            if WinHttpSetOption(
                session.0,
                WINHTTP_OPTION_SECURE_PROTOCOLS,
                &protocols as *const u32 as *const c_void,
                std::mem::size_of::<u32>() as u32,
            ) == 0
            {
                protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
                let _ = WinHttpSetOption(
                    session.0,
                    WINHTTP_OPTION_SECURE_PROTOCOLS,
                    &protocols as *const u32 as *const c_void,
                    std::mem::size_of::<u32>() as u32,
                );
            }
        }

        let host_w = to_wide(&host);
        let connect_raw = unsafe { WinHttpConnect(session.0, host_w.as_ptr(), port, 0) };
        if connect_raw.is_null() {
            let err = unsafe { GetLastError() };
            return Err(format!("连接更新服务器失败 (错误码 {})", err));
        }
        let connect = Handle(connect_raw);

        let verb_w = to_wide("GET");
        let path_w = to_wide(&path);
        let flags = if is_https { WINHTTP_FLAG_SECURE } else { 0 };
        let req_raw = unsafe {
            WinHttpOpenRequest(
                connect.0,
                verb_w.as_ptr(),
                path_w.as_ptr(),
                null(),
                null(),
                null(),
                flags,
            )
        };
        if req_raw.is_null() {
            let err = unsafe { GetLastError() };
            return Err(format!("创建更新请求失败 (错误码 {})", err));
        }
        let request = Handle(req_raw);

        let headers_w = extra_headers.map(to_wide);
        let (hdr_ptr, hdr_len) = match &headers_w {
            Some(buf) => (buf.as_ptr(), (buf.len().saturating_sub(1)) as u32),
            None => (null(), 0),
        };

        let sent = unsafe {
            WinHttpSendRequest(request.0, hdr_ptr, hdr_len, null(), 0, 0, 0)
        };
        if sent == 0 {
            let err = unsafe { GetLastError() };
            return Err(format!("连接 GitHub 检查更新失败，请检查网络或代理 (错误码 {})", err));
        }

        let received = unsafe { WinHttpReceiveResponse(request.0, null_mut()) };
        if received == 0 {
            let err = unsafe { GetLastError() };
            return Err(format!("等待 GitHub 响应失败，请检查网络或代理 (错误码 {})", err));
        }

        let mut status_code: u32 = 0;
        let mut status_size = std::mem::size_of::<u32>() as u32;
        let got_status = unsafe {
            WinHttpQueryHeaders(
                request.0,
                WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                null(),
                &mut status_code as *mut u32 as *mut c_void,
                &mut status_size,
                null_mut(),
            )
        };
        if got_status == 0 {
            let err = unsafe { GetLastError() };
            return Err(format!("读取 HTTP 状态码失败 (错误码 {})", err));
        }
        if !(200..=299).contains(&status_code) {
            return Err(format!("服务器返回 HTTP {}", status_code));
        }

        let mut buf = vec![0u8; 32 * 1024];
        loop {
            let mut available: u32 = 0;
            if unsafe { WinHttpQueryDataAvailable(request.0, &mut available) } == 0 {
                let err = unsafe { GetLastError() };
                return Err(format!("读取网络数据流失败 (错误码 {})", err));
            }
            if available == 0 {
                break;
            }
            let mut remaining = available as usize;
            while remaining > 0 {
                let to_read = remaining.min(buf.len()) as u32;
                let mut bytes_read: u32 = 0;
                if unsafe {
                    WinHttpReadData(
                        request.0,
                        buf.as_mut_ptr() as *mut c_void,
                        to_read,
                        &mut bytes_read,
                    )
                } == 0
                {
                    let err = unsafe { GetLastError() };
                    return Err(format!("读取响应内容失败 (错误码 {})", err));
                }
                if bytes_read == 0 {
                    break;
                }
                on_chunk(&buf[..bytes_read as usize])?;
                remaining = remaining.saturating_sub(bytes_read as usize);
            }
        }

        Ok(())
    }
}

#[cfg(windows)]
fn fetch_latest_release_json() -> Result<String, String> {
    let ua = format!("KuroCat/{}", CURRENT_VERSION);
    let mut body = Vec::with_capacity(8192);
    winhttp_client::get_stream(
        REPO_API_LATEST,
        &ua,
        Some("Accept: application/vnd.github+json\r\n"),
        20_000,
        |chunk| {
            if body.len() + chunk.len() > 2 * 1024 * 1024 {
                return Err("更新接口响应过大".to_string());
            }
            body.extend_from_slice(chunk);
            Ok(())
        },
    )?;

    let text = String::from_utf8_lossy(&body).trim().to_string();
    if text.is_empty() {
        return Err("GitHub 返回空响应".to_string());
    }
    Ok(text)
}

#[cfg(not(windows))]
fn fetch_latest_release_json() -> Result<String, String> {
    use std::process::Command;

    let curl_bin = if cfg!(target_os = "macos") {
        "/usr/bin/curl"
    } else {
        "curl"
    };
    let output = Command::new(curl_bin)
        .args([
            "-fsSL",
            "--connect-timeout",
            "10",
            "--max-time",
            "20",
            "-H",
            &format!("User-Agent: KuroCat/{}", CURRENT_VERSION),
            "-H",
            "Accept: application/vnd.github+json",
            REPO_API_LATEST,
        ])
        .output()
        .map_err(|e| format!("无法调用 curl 检查更新: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "连接 GitHub 检查更新失败，请检查网络或代理".to_string()
        } else {
            format!("检查更新失败: {}", stderr)
        });
    }

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        return Err("GitHub 返回空响应".to_string());
    }
    Ok(text)
}

pub fn check_latest_update() -> Result<UpdateInfo, String> {
    let raw_json = fetch_latest_release_json()?;
    let rel: GhRelease = serde_json::from_str(&raw_json)
        .map_err(|e| format!("解析最新版本信息失败: {}", e))?;

    let latest_clean = rel
        .tag_name
        .trim()
        .trim_start_matches(['v', 'V'])
        .to_string();
    let has_update = is_newer_version(&latest_clean, CURRENT_VERSION);

    Ok(UpdateInfo {
        current_version: CURRENT_VERSION.to_string(),
        latest_version: latest_clean,
        has_update,
        release_url: rel
            .html_url
            .filter(|url| url.starts_with("https://github.com/qianyiai/kurocat/releases/"))
            .unwrap_or_else(|| REPO_RELEASES_PAGE.to_string()),
        notes_summary: summarize_notes(rel.body.as_deref()),
    })
}

fn emit_progress(app: &AppHandle, stage: &str, message: impl Into<String>, info: Option<UpdateInfo>) {
    let _ = app.emit(
        "kuro-update-status",
        UpdateProgressEvent {
            stage: stage.to_string(),
            message: message.into(),
            info,
        },
    );
}

pub fn open_url_in_browser(url: &str) {
    #[cfg(windows)]
    {
        use std::ptr::{null, null_mut};
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let op: Vec<u16> = "open\0".encode_utf16().collect();
        let target: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            ShellExecuteW(
                null_mut(),
                op.as_ptr(),
                target.as_ptr(),
                null(),
                null(),
                SW_SHOWNORMAL,
            );
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("/usr/bin/open").arg(url).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

pub fn start_background_update_checker(app: AppHandle) {
    std::thread::spawn(move || {
        // Gentle initial delay after launch so startup stays instant & quiet
        std::thread::sleep(std::time::Duration::from_secs(8));
        loop {
            if let Ok(info) = check_latest_update() {
                if info.has_update {
                    emit_progress(
                        &app,
                        "available",
                        format!("发现新版本 v{}", info.latest_version),
                        Some(info),
                    );
                }
            }
            // Re-check every 6 hours while running
            std::thread::sleep(std::time::Duration::from_secs(6 * 3600));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_comparison_works() {
        assert!(is_newer_version("4.4.0", "4.3.0"));
        assert!(is_newer_version("v4.10.0", "4.4.0"));
        assert!(is_newer_version("5.0.0", "4.9.9"));
        assert!(!is_newer_version("4.4.0", "4.4.0"));
        assert!(!is_newer_version("v4.3.9", "4.4.0"));
    }

    #[test]
    fn http_url_parser_handles_github_endpoints() {
        let (https, host, port, path) =
            parse_http_url("https://api.github.com/repos/qianyiai/kurocat/releases/latest").unwrap();
        assert!(https);
        assert_eq!(host, "api.github.com");
        assert_eq!(port, 443);
        assert_eq!(path, "/repos/qianyiai/kurocat/releases/latest");

        let (https2, host2, port2, path2) =
            parse_http_url("http://127.0.0.1:8080/dl?v=1").unwrap();
        assert!(!https2);
        assert_eq!(host2, "127.0.0.1");
        assert_eq!(port2, 8080);
        assert_eq!(path2, "/dl?v=1");
    }

    #[test]
    #[ignore = "requires live internet access to GitHub API"]
    fn live_check_latest_update_uses_native_http() {
        let info = check_latest_update().expect("upstream GitHub release check should succeed");
        assert!(!info.latest_version.is_empty());
        assert!(info.release_url.starts_with("https://github.com/qianyiai/kurocat/releases/"));
    }
}
