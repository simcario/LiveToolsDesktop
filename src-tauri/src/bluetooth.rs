// Bluetooth devices connected to this computer, to show which page-turner
// pedal is ready. Pedals pair as keyboards (HID): the app only receives their
// keys, so the device itself is looked up through Windows.

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothEntry {
    pub id: String,
    pub name: String,
    /// "classic" or "le" (Bluetooth Low Energy).
    pub kind: &'static str,
    /// Keyboard, remote or other input device: what a pedal looks like.
    pub input: bool,
}

#[cfg(windows)]
fn list() -> windows::core::Result<Vec<BluetoothEntry>> {
    use windows::Devices::Bluetooth::{
        BluetoothConnectionStatus, BluetoothDevice, BluetoothLEAppearanceCategories, BluetoothLEDevice, BluetoothMajorClass,
    };
    use windows::Devices::Enumeration::DeviceInformation;

    let mut out = Vec::new();
    let classic = BluetoothDevice::GetDeviceSelectorFromConnectionStatus(BluetoothConnectionStatus::Connected)?;
    let found = DeviceInformation::FindAllAsyncAqsFilter(&classic)?.join()?;
    for i in 0..found.Size()? {
        let info = found.GetAt(i)?;
        let id = info.Id()?;
        let input = BluetoothDevice::FromIdAsync(&id)
            .and_then(|op| op.join())
            .and_then(|d| d.ClassOfDevice())
            .and_then(|c| c.MajorClass())
            .map(|m| m == BluetoothMajorClass::Peripheral)
            .unwrap_or(false);
        out.push(BluetoothEntry { id: id.to_string(), name: info.Name()?.to_string(), kind: "classic", input });
    }
    let le = BluetoothLEDevice::GetDeviceSelectorFromConnectionStatus(BluetoothConnectionStatus::Connected)?;
    let found = DeviceInformation::FindAllAsyncAqsFilter(&le)?.join()?;
    let hid = BluetoothLEAppearanceCategories::HumanInterfaceDevice().unwrap_or(0x0F);
    for i in 0..found.Size()? {
        let info = found.GetAt(i)?;
        let id = info.Id()?;
        let input = BluetoothLEDevice::FromIdAsync(&id)
            .and_then(|op| op.join())
            .and_then(|d| d.Appearance())
            .and_then(|a| a.Category())
            .map(|c| c == hid)
            .unwrap_or(false);
        out.push(BluetoothEntry { id: id.to_string(), name: info.Name()?.to_string(), kind: "le", input });
    }
    // Input devices (the pedals) first.
    out.sort_by(|a, b| b.input.cmp(&a.input).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

#[cfg(not(windows))]
fn list() -> Result<Vec<BluetoothEntry>, String> {
    Ok(Vec::new())
}

#[tauri::command]
pub async fn bluetooth_devices() -> Result<Vec<BluetoothEntry>, String> {
    tauri::async_runtime::spawn_blocking(|| list().map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}
