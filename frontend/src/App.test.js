import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

let xhr;

beforeEach(() => {
  // jsdom kennt weder Blob-URLs noch echte Uploads
  global.URL.createObjectURL = jest.fn(() => "blob:test");
  global.URL.revokeObjectURL = jest.fn();
  xhr = { open: jest.fn(), send: jest.fn(), upload: {} };
  global.XMLHttpRequest = jest.fn(() => xhr);
  window.localStorage.clear();
});

const chooseFile = (file) =>
  fireEvent.change(screen.getByTestId("file-input"), { target: { files: [file] } });

const video = () => new File(["x"], "clip.mp4", { type: "video/mp4" });

async function renderReady() {
  render(<App />);
  // Plattform wird asynchron geladen; danach ist der Knopf aktiv
  await waitFor(() => expect(screen.getByRole("button", { name: "Choose video" })).toBeEnabled());
}

async function renderWithVideo() {
  await renderReady();
  chooseFile(video());
  await screen.findByText("clip.mp4");
}

test("starts with an invitation to drop or choose a video", async () => {
  await renderReady();
  expect(screen.getByRole("heading", { name: /Drop a video here/ })).toBeInTheDocument();
});

test("uploads a chosen video to /store and shows the editor", async () => {
  await renderReady();
  const file = video();
  chooseFile(file);

  await waitFor(() => expect(xhr.open).toHaveBeenCalledWith("POST", "http://localhost:9000/store"));
  expect(xhr.send.mock.calls[0][0].get("video")).toBe(file);
  expect(screen.getByText("clip.mp4")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Export and download" })).toBeInTheDocument();
});

test("quality has three modes side by side, compress with its levels", async () => {
  await renderWithVideo();
  expect(screen.getByLabelText("Original")).toBeInTheDocument();
  expect(screen.getByLabelText("Compress")).toBeChecked();
  expect(screen.getByLabelText("Target size")).toBeInTheDocument();
  expect(screen.getByLabelText(/Medium/)).toBeChecked();
  expect(screen.getByLabelText("With sound")).toBeChecked();
  expect(screen.getByLabelText("No sound")).toBeInTheDocument();
});

test("original mode explains that it only cuts", async () => {
  await renderWithVideo();
  fireEvent.click(screen.getByLabelText("Original"));
  expect(screen.getByText(/Cuts without re-encoding/)).toBeInTheDocument();
  expect(screen.queryByLabelText(/Medium/)).not.toBeInTheDocument();
});

test("target size offers common sizes and a custom value", async () => {
  await renderWithVideo();
  fireEvent.click(screen.getByLabelText("Target size"));
  expect(screen.getByLabelText("25 MB")).toBeChecked();
  fireEvent.click(screen.getByLabelText("10 MB"));
  expect(screen.getByLabelText("Size in MB")).toHaveValue(10);
  fireEvent.change(screen.getByLabelText("Size in MB"), { target: { value: "8" } });
  expect(screen.getByLabelText("10 MB")).not.toBeChecked();
});

test("audio-only output disables the quality choices without hiding them", async () => {
  await renderWithVideo();
  fireEvent.click(screen.getByLabelText("Sound only"));
  expect(screen.getByLabelText(/Medium/)).toBeDisabled();
  expect(screen.getByText("MP3, 192 kbit/s")).toBeInTheDocument();
});

test("video without sound hides the volume slider and says so", async () => {
  await renderWithVideo();
  expect(screen.getByLabelText("Volume")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("No sound"));
  expect(screen.queryByLabelText("Volume")).not.toBeInTheDocument();
  expect(screen.getByText("The result has no sound.")).toBeInTheDocument();
});

test("opening a second video replaces the first without passing through the start screen", async () => {
  await renderWithVideo();
  fireEvent.click(screen.getByLabelText("No sound"));

  const seen = [];
  const observer = new MutationObserver(() => {
    if (screen.queryByRole("heading", { name: /Drop a video here/ })) seen.push("start");
  });
  observer.observe(document.body, { childList: true, subtree: true });
  chooseFile(new File(["y"], "second.mp4", { type: "video/mp4" }));
  await screen.findByText("second.mp4");
  observer.disconnect();

  expect(seen).toEqual([]);
  expect(screen.queryByText("clip.mp4")).not.toBeInTheDocument();
  // Einstellungen des alten Videos sind weg
  expect(screen.getByLabelText("With sound")).toBeChecked();
});

test("rejects files that are not videos with a clear message", async () => {
  await renderReady();
  chooseFile(new File(["x"], "notes.pdf", { type: "application/pdf" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("This file isn't a video");
  expect(xhr.open).not.toHaveBeenCalled();
});

test("shows upload progress while the original is sent", async () => {
  await renderWithVideo();

  act(() => xhr.upload.onprogress({ lengthComputable: true, loaded: 42, total: 100 }));
  expect(screen.getByRole("progressbar", { name: "Uploading, 42 %" })).toBeInTheDocument();

  xhr.responseText = JSON.stringify({ status: "success", originalId: "abc" });
  act(() => xhr.onload());
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});

test("Ctrl+Z takes back settings, Ctrl+Y redoes them; trim has no undo buttons", async () => {
  await renderWithVideo();
  expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();

  fireEvent.click(screen.getByLabelText("No sound"));
  fireEvent.keyDown(window, { code: "KeyZ", ctrlKey: true });
  expect(screen.getByLabelText("With sound")).toBeChecked();

  fireEvent.keyDown(window, { code: "KeyY", ctrlKey: true });
  expect(screen.getByLabelText("No sound")).toBeChecked();
});

test("several changes are undone one after another", async () => {
  jest.useFakeTimers();
  try {
    await renderWithVideo();
    fireEvent.click(screen.getByLabelText("Target size"));
    act(() => jest.advanceTimersByTime(600));
    fireEvent.click(screen.getByLabelText("10 MB"));
    act(() => jest.advanceTimersByTime(600));

    fireEvent.keyDown(window, { code: "KeyZ", ctrlKey: true });
    expect(screen.getByLabelText("25 MB")).toBeChecked();
    fireEvent.keyDown(window, { code: "KeyZ", ctrlKey: true });
    expect(screen.getByLabelText("Compress")).toBeChecked();
    // Strg+Umschalt+Z wiederholt
    fireEvent.keyDown(window, { code: "KeyZ", ctrlKey: true, shiftKey: true });
    expect(screen.getByRole("radio", { name: "Target size" })).toBeChecked();
  } finally {
    jest.useRealTimers();
  }
});

test("custom quality reveals resolution, frame rate and bitrate", async () => {
  await renderWithVideo();
  fireEvent.click(screen.getByLabelText(/Custom/));
  expect(screen.getByLabelText("Resolution")).toBeInTheDocument();
  expect(screen.getByLabelText("Frames per second")).toBeInTheDocument();
  expect(screen.getByLabelText("Bitrate in kbit/s")).toBeInTheDocument();
});

test("settings switch the theme and remember it", async () => {
  await renderReady();
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  fireEvent.click(screen.getByLabelText("Light"));
  expect(document.documentElement.dataset.theme).toBe("light");
  fireEvent.click(screen.getByLabelText("Green"));
  expect(document.documentElement.dataset.accent).toBe("green");
  expect(JSON.parse(window.localStorage.getItem("trimly.settings"))).toMatchObject({ theme: "light", accent: "green" });
  // Desktop-Einstellungen gibt es im Browser nicht
  expect(screen.queryByText("Save exports to")).not.toBeInTheDocument();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
});

test("the web version switches to the editor and back without losing the trim view", async () => {
  await renderWithVideo();
  fireEvent.click(screen.getByLabelText("No sound"));

  fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
  expect(screen.getByRole("tab", { name: "Editor" })).toHaveAttribute("aria-selected", "true");
  // jsdom lädt keine Videodaten, daher zeigt der Editor seinen Wartehinweis
  // (der Editor wird nachgeladen, darum findBy)
  expect(await screen.findByText(/Load a video in the Trim tab first/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("tab", { name: "Trim" }));
  expect(screen.getByLabelText("No sound")).toBeChecked();
});

// ─── „Nur berechnen“ und Player-Lautstärke ──────────────────────────────

async function renderWithLoadedVideo() {
  await renderWithVideo();
  // Upload bestätigen
  xhr.responseText = JSON.stringify({ status: "success", originalId: "orig-1" });
  act(() => xhr.onload());
  const el = document.querySelector("video");
  Object.defineProperty(el, "duration", { value: 10, configurable: true });
  Object.defineProperty(el, "videoWidth", { value: 1920, configurable: true });
  Object.defineProperty(el, "videoHeight", { value: 1080, configurable: true });
  fireEvent.loadedMetadata(el);
  await waitFor(() => expect(screen.getByRole("button", { name: "Export and download" })).toBeEnabled());
}

function mockServer() {
  const calls = [];
  global.fetch = jest.fn(async (url) => {
    calls.push(String(url));
    const body = String(url).endsWith("/process")
      ? { status: "success", filename: "result.mp4" }
      : { status: "ready", size: 1234567 };
    return { json: async () => body };
  });
  return calls;
}

async function calculate() {
  fireEvent.click(screen.getByRole("button", { name: "More export options" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Calculate exact size/ }));
  await screen.findByText(/^exactly /, {}, { timeout: 3000 });
}

test("calculating shows the exact size and a later export downloads without encoding again", async () => {
  await renderWithLoadedVideo();
  const calls = mockServer();
  const click = jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

  await calculate();
  expect(screen.getByText("exactly 1.18 MB")).toBeInTheDocument();
  expect(click).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Export and download" }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  expect(calls.filter((u) => u.endsWith("/process"))).toHaveLength(1);
  expect(await screen.findByText(/is ready/)).toBeInTheDocument();
  click.mockRestore();
});

test("changing a setting discards a calculated result", async () => {
  await renderWithLoadedVideo();
  mockServer();
  await calculate();
  fireEvent.click(screen.getByLabelText(/High/));
  expect(screen.queryByText(/^exactly /)).not.toBeInTheDocument();
  expect(screen.getByText(/^about /)).toBeInTheDocument();
});

test("the player has its own volume that doesn't touch the export volume", async () => {
  await renderWithVideo();
  const player = screen.getByRole("slider", { name: "Player volume" });
  fireEvent.change(player, { target: { value: "0.3" } });
  expect(document.querySelector("video").volume).toBeCloseTo(0.3);
  expect(screen.getByRole("slider", { name: "Volume" })).toHaveValue("1");

  fireEvent.click(screen.getByRole("button", { name: "Mute player" }));
  expect(document.querySelector("video").muted).toBe(true);
  expect(window.localStorage.getItem("trimly.playerVolume")).toBe("0.3");
});

test("the home button goes back to the start screen", async () => {
  await renderWithVideo();
  fireEvent.click(screen.getByRole("button", { name: "Start screen" }));
  expect(screen.getByRole("heading", { name: /Drop a video here/ })).toBeInTheDocument();
  expect(screen.queryByText("clip.mp4")).not.toBeInTheDocument();
});

test("Ctrl+O opens the file chooser", async () => {
  await renderReady();
  const click = jest.spyOn(screen.getByTestId("file-input"), "click").mockImplementation(() => {});
  fireEvent.keyDown(window, { code: "KeyO", ctrlKey: true });
  await waitFor(() => expect(click).toHaveBeenCalled());
});

test("the encoder note sits in the export column", async () => {
  await renderWithVideo();
  const note = await screen.findByText("Encoding on the server");
  expect(note.closest(".panel")).not.toBeNull();
});
