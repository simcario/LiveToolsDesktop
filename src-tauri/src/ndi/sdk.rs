//! The NDI® runtime (Processing.NDI.Lib), loaded when an output is turned on:
//! it comes with NDI Tools or the NDI Runtime (ndi.video), so LiveTools starts
//! and works without it. Only the few calls of a video sender are bound.

use std::ffi::{c_char, c_void, CString};
use std::sync::Arc;

use libloading::Library;

#[repr(C)]
struct SendCreate {
    name: *const c_char,
    groups: *const c_char,
    clock_video: bool,
    clock_audio: bool,
}

/// NDIlib_video_frame_v2_t.
#[repr(C)]
struct VideoFrameV2 {
    xres: i32,
    yres: i32,
    fourcc: u32,
    frame_rate_n: i32,
    frame_rate_d: i32,
    picture_aspect_ratio: f32,
    frame_format_type: i32,
    timecode: i64,
    data: *const u8,
    line_stride_in_bytes: i32,
    metadata: *const c_char,
    timestamp: i64,
}

const fn fourcc(c: &[u8; 4]) -> u32 {
    c[0] as u32 | (c[1] as u32) << 8 | (c[2] as u32) << 16 | (c[3] as u32) << 24
}

/// Pixel layouts of the frames sent (4 bytes per pixel, alpha ignored).
pub const BGRX: u32 = fourcc(b"BGRX");
pub const RGBX: u32 = fourcc(b"RGBX");

const FRAME_PROGRESSIVE: i32 = 1;
const TIMECODE_SYNTHESIZE: i64 = i64::MAX;

/// A picture to send: rows of `width * 4` bytes, top to bottom.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub fourcc: u32,
    pub fps: (i32, i32),
    pub data: Vec<u8>,
}

impl Frame {
    pub fn black(width: u32, height: u32) -> Self {
        Frame { width, height, fourcc: BGRX, fps: (30, 1), data: vec![0; (width * height * 4) as usize] }
    }
}

pub struct Runtime {
    _lib: Library,
    destroy: unsafe extern "C" fn(),
    send_create: unsafe extern "C" fn(*const SendCreate) -> *mut c_void,
    send_destroy: unsafe extern "C" fn(*mut c_void),
    send_video: unsafe extern "C" fn(*mut c_void, *const VideoFrameV2),
}

fn candidates() -> Vec<std::path::PathBuf> {
    #[cfg(windows)]
    {
        const DLL: &str = "Processing.NDI.Lib.x64.dll";
        let mut list: Vec<_> = ["NDI_RUNTIME_DIR_V6", "NDI_RUNTIME_DIR_V5", "NDI_RUNTIME_DIR_V4"]
            .iter()
            .filter_map(|v| std::env::var_os(v))
            .map(|dir| std::path::PathBuf::from(dir).join(DLL))
            .collect();
        // The SDK (developers) has its own copy.
        if let Some(sdk) = std::env::var_os("NDI_SDK_DIR") {
            list.push(std::path::PathBuf::from(sdk).join("Bin").join("x64").join(DLL));
        }
        // Installed after LiveTools (or the shell that started it) was opened, the
        // variables above are not seen yet: look in the install folder too.
        let root = std::path::PathBuf::from(std::env::var_os("ProgramFiles").unwrap_or_else(|| r"C:\Program Files".into())).join("NDI");
        find(&root, DLL, 4, &mut list);
        list.push(DLL.into());
        list
    }
    #[cfg(target_os = "macos")]
    {
        vec!["/usr/local/lib/libndi.dylib".into(), "libndi.dylib".into()]
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        vec!["libndi.so.6".into(), "libndi.so.5".into()]
    }
}

/// Every `name` under `dir`, newest NDI version first (folders "NDI 6 …" before "NDI 5 …").
#[cfg(windows)]
fn find(dir: &std::path::Path, name: &str, depth: u32, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    entries.sort_by(|a, b| b.cmp(a));
    for p in entries {
        if p.is_dir() {
            if depth > 0 {
                find(&p, name, depth - 1, out);
            }
        } else if p.file_name().is_some_and(|f| f.eq_ignore_ascii_case(name)) {
            out.push(p);
        }
    }
}

impl Runtime {
    pub fn load() -> Result<Arc<Self>, String> {
        let lib = candidates()
            .into_iter()
            .find_map(|p| unsafe { Library::new(&p) }.ok())
            .ok_or("NDI Runtime non trovato: installa NDI Tools o NDI Runtime da ndi.video e riavvia LiveTools")?;
        unsafe {
            fn symbol<T: Copy>(lib: &Library, name: &[u8]) -> Result<T, String> {
                unsafe { lib.get::<T>(name).map(|s| *s).map_err(|e| e.to_string()) }
            }
            let initialize: unsafe extern "C" fn() -> bool = symbol(&lib, b"NDIlib_initialize\0")?;
            let destroy = symbol(&lib, b"NDIlib_destroy\0")?;
            let send_create = symbol(&lib, b"NDIlib_send_create\0")?;
            let send_destroy = symbol(&lib, b"NDIlib_send_destroy\0")?;
            let send_video = symbol(&lib, b"NDIlib_send_send_video_v2\0")?;
            if !initialize() {
                return Err("NDI non supportato da questo processore".into());
            }
            Ok(Arc::new(Runtime { _lib: lib, destroy, send_create, send_destroy, send_video }))
        }
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe { (self.destroy)() }
    }
}

/// An NDI source on the network. `send` waits for the frame's turn at its
/// frame rate (clock_video), so a loop that sends is paced by NDI.
pub struct Sender {
    rt: Arc<Runtime>,
    instance: *mut c_void,
    _name: CString,
}

// The instance is used by one thread at a time (the one of its output).
unsafe impl Send for Sender {}

impl Sender {
    pub fn new(rt: Arc<Runtime>, name: &str) -> Result<Self, String> {
        let name = CString::new(name.replace('\0', "")).map_err(|e| e.to_string())?;
        let create = SendCreate { name: name.as_ptr(), groups: std::ptr::null(), clock_video: true, clock_audio: false };
        let instance = unsafe { (rt.send_create)(&create) };
        if instance.is_null() {
            return Err(format!("NDI: impossibile creare l’uscita “{}”", name.to_string_lossy()));
        }
        Ok(Sender { rt, instance, _name: name })
    }

    pub fn send(&self, f: &Frame) {
        let frame = VideoFrameV2 {
            xres: f.width as i32,
            yres: f.height as i32,
            fourcc: f.fourcc,
            frame_rate_n: f.fps.0,
            frame_rate_d: f.fps.1,
            picture_aspect_ratio: 0.0, // square pixels
            frame_format_type: FRAME_PROGRESSIVE,
            timecode: TIMECODE_SYNTHESIZE,
            data: f.data.as_ptr(),
            line_stride_in_bytes: (f.width * 4) as i32,
            metadata: std::ptr::null(),
            timestamp: 0,
        };
        // Synchronous: the data is no longer used when it returns.
        unsafe { (self.rt.send_video)(self.instance, &frame) }
    }
}

impl Drop for Sender {
    fn drop(&mut self) {
        unsafe { (self.rt.send_destroy)(self.instance) }
    }
}
