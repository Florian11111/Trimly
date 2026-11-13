import { useEffect, useRef } from "react";
import { CODECS } from "../lib/presets";
import { ACCENTS, THEMES } from "../lib/settings";

/**
 * Small settings menu under the gear in the header.
 * `encoders`: devices from encoder_info ({ id, label, codecs }), desktop only.
 */
export default function Settings({ settings, update, desktop, encoders = [], onPickFolder, onClose }) {
  const ref = useRef(null);

  // Escape and a click outside close it
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target) && !e.target.closest?.(".settings-toggle")) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose]);

  const device = encoders.find((e) => e.id === settings.encoder);
  const canCodec = (codec) =>
    codec === "h264" ||
    (settings.encoder === "cpu"
      ? false
      : settings.encoder === "auto"
        ? encoders.some((e) => e.codecs.includes(codec))
        : !!device?.codecs.includes(codec));
  const codecNote =
    settings.codec !== "h264" && !canCodec(settings.codec)
      ? `${settings.encoder === "cpu" ? "The CPU" : "This encoder"} can't make ${
          CODECS.find((c) => c.id === settings.codec)?.label
        }, Trimly uses H.264 instead.`
      : null;

  return (
    <div className="settings" ref={ref} role="dialog" aria-label="Settings">
      <section className="settings-group">
        <h2>Appearance</h2>
        <div className="settings-row">
          <span className="settings-label">Theme</span>
          <div className="segmented segmented-small" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <label key={t.id} className={`segment ${settings.theme === t.id ? "is-active" : ""}`}>
                <input
                  type="radio"
                  name="theme"
                  checked={settings.theme === t.id}
                  onChange={() => update({ theme: t.id })}
                />
                <span>{t.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <span className="settings-label">Accent</span>
          <div className="swatches" role="radiogroup" aria-label="Accent color">
            {ACCENTS.map((a) => (
              <label key={a.id} className={`swatch ${settings.accent === a.id ? "is-active" : ""}`} title={a.label}>
                <input
                  type="radio"
                  name="accent"
                  aria-label={a.label}
                  checked={settings.accent === a.id}
                  onChange={() => update({ accent: a.id })}
                />
                <span style={{ background: a.color }} />
              </label>
            ))}
          </div>
        </div>
      </section>

      {desktop && (
        <section className="settings-group">
          <h2>Export</h2>
          <div className="settings-row settings-row-stack">
            <span className="settings-label">Format</span>
            <div className="segmented segmented-small" role="radiogroup" aria-label="Video format">
              {CODECS.map((c) => (
                <label
                  key={c.id}
                  className={`segment ${settings.codec === c.id ? "is-active" : ""}`}
                  title={c.hint}
                >
                  <input
                    type="radio"
                    name="codec"
                    checked={settings.codec === c.id}
                    onChange={() => update({ codec: c.id })}
                  />
                  <span>{c.label}</span>
                </label>
              ))}
            </div>
            <span className="settings-hint">
              {codecNote || CODECS.find((c) => c.id === settings.codec)?.hint}
            </span>
          </div>

          <label className="settings-row settings-row-stack">
            <span className="settings-label">Encoder</span>
            <select value={settings.encoder} onChange={(e) => update({ encoder: e.target.value })}>
              <option value="auto">Automatic (fastest available)</option>
              {encoders.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label} (GPU)
                </option>
              ))}
              <option value="cpu">CPU (libx264, H.264 only)</option>
            </select>
          </label>

          <div className="settings-row settings-row-stack">
            <span className="settings-label">Save exports to</span>
            <span className="settings-path" title={settings.outputDir || ""}>
              {settings.outputDir || "Ask every time"}
            </span>
            <div className="settings-actions">
              <button type="button" className="btn btn-quiet btn-small" onClick={onPickFolder}>
                Choose folder…
              </button>
              {settings.outputDir && (
                <button type="button" className="btn btn-quiet btn-small" onClick={() => update({ outputDir: null })}>
                  Ask every time
                </button>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
