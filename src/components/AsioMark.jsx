// ASIO Compatible logo as Steinberg provides it (public/brand/asio-compatible.svg, unaltered) with
// the attribution next to it. The Steinberg ASIO Usage Guidelines (src-tauri/vendor/asiosdk) want it
// in every dialog that turns ASIO on and in the About box.
export default function AsioMark({ className = '' }) {
  return (
    <div className={`asio-mark ${className}`}>
      <img src="/brand/asio-compatible.svg" alt="ASIO Compatible" width="56" height="36" />
      <span>ASIO is a registered trademark of Steinberg Media Technologies GmbH.</span>
    </div>
  );
}
