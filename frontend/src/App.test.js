import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

let xhr;

beforeEach(() => {
  // jsdom kennt weder Blob-URLs noch echte Uploads
  global.URL.createObjectURL = jest.fn(() => "blob:test");
  global.URL.revokeObjectURL = jest.fn();
  xhr = { open: jest.fn(), send: jest.fn(), upload: {} };
  global.XMLHttpRequest = jest.fn(() => xhr);
});

const chooseFile = (file) =>
  fireEvent.change(screen.getByTestId("file-input"), { target: { files: [file] } });

const video = () => new File(["x"], "clip.mp4", { type: "video/mp4" });

async function renderReady() {
  render(<App />);
  // Plattform wird asynchron geladen; danach ist der Knopf aktiv
  await waitFor(() => expect(screen.getByRole("button", { name: "Video auswählen" })).toBeEnabled());
}

test("starts with an invitation to drop or choose a video", async () => {
  await renderReady();
  expect(screen.getByRole("heading", { name: /Video hierher ziehen/ })).toBeInTheDocument();
});

test("uploads a chosen video to /store and shows the editor", async () => {
  await renderReady();
  const file = video();
  chooseFile(file);

  await waitFor(() => expect(xhr.open).toHaveBeenCalledWith("POST", "http://localhost:9000/store"));
  expect(xhr.send.mock.calls[0][0].get("video")).toBe(file);
  expect(screen.getByText("clip.mp4")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Exportieren und herunterladen" })).toBeInTheDocument();
});

test("the web version offers the original preset and all output modes", async () => {
  await renderReady();
  chooseFile(video());
  await screen.findByText("clip.mp4");
  expect(screen.getByLabelText(/Original/)).toBeInTheDocument();
  expect(screen.getByLabelText(/Mittel/)).toBeChecked();
  expect(screen.getByLabelText("Mit Ton")).toBeChecked();
  expect(screen.getByLabelText("Ohne Ton")).toBeInTheDocument();
});

test("audio-only output disables the quality choices without hiding them", async () => {
  await renderReady();
  chooseFile(video());
  await screen.findByText("clip.mp4");
  fireEvent.click(screen.getByLabelText("Nur Ton"));
  expect(screen.getByLabelText(/Mittel/)).toBeDisabled();
  expect(screen.getByText("MP3, 192 kbit/s")).toBeInTheDocument();
});

test("video without sound hides the volume slider and says so", async () => {
  await renderReady();
  chooseFile(video());
  await screen.findByText("clip.mp4");
  expect(screen.getByLabelText("Lautstärke")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Ohne Ton"));
  expect(screen.queryByLabelText("Lautstärke")).not.toBeInTheDocument();
  expect(screen.getByText("Das Ergebnis hat keinen Ton.")).toBeInTheDocument();
});

test("opening a second video replaces the first without passing through the start screen", async () => {
  await renderReady();
  chooseFile(video());
  await screen.findByText("clip.mp4");
  fireEvent.click(screen.getByLabelText("Ohne Ton"));

  const seen = [];
  const observer = new MutationObserver(() => {
    if (screen.queryByRole("heading", { name: /Video hierher ziehen/ })) seen.push("start");
  });
  observer.observe(document.body, { childList: true, subtree: true });
  chooseFile(new File(["y"], "zweites.mp4", { type: "video/mp4" }));
  await screen.findByText("zweites.mp4");
  observer.disconnect();

  expect(seen).toEqual([]);
  expect(screen.queryByText("clip.mp4")).not.toBeInTheDocument();
  // Einstellungen des alten Videos sind weg
  expect(screen.getByLabelText("Mit Ton")).toBeChecked();
});

test("rejects files that are not videos with a clear message", async () => {
  await renderReady();
  chooseFile(new File(["x"], "notes.pdf", { type: "application/pdf" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Diese Datei ist kein Video");
  expect(xhr.open).not.toHaveBeenCalled();
});

test("shows upload progress while the original is sent", async () => {
  await renderReady();
  chooseFile(video());
  await screen.findByText("clip.mp4");

  act(() => xhr.upload.onprogress({ lengthComputable: true, loaded: 42, total: 100 }));
  expect(screen.getByRole("progressbar", { name: "Wird hochgeladen, 42 %" })).toBeInTheDocument();

  xhr.responseText = JSON.stringify({ status: "success", originalId: "abc" });
  act(() => xhr.onload());
  expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
});

test("custom quality reveals resolution, frame rate and bitrate", async () => {
  await renderReady();
  chooseFile(video());
  await screen.findByText("clip.mp4");

  fireEvent.click(screen.getByLabelText(/Eigene/));
  expect(screen.getByLabelText("Auflösung")).toBeInTheDocument();
  expect(screen.getByLabelText("Bilder pro Sekunde")).toBeInTheDocument();
  expect(screen.getByLabelText("Bitrate in kbit/s")).toBeInTheDocument();
});

test("the web version switches to the editor and back without losing the trim view", async () => {
  await renderReady();
  chooseFile(video());
  await screen.findByText("clip.mp4");
  fireEvent.click(screen.getByLabelText("Ohne Ton"));

  fireEvent.click(screen.getByRole("tab", { name: "Editor" }));
  expect(screen.getByRole("tab", { name: "Editor" })).toHaveAttribute("aria-selected", "true");
  // jsdom lädt keine Videodaten, daher zeigt der Editor seinen Wartehinweis
  expect(screen.getByText(/Lade zuerst ein Video/)).toBeInTheDocument();

  fireEvent.click(screen.getByRole("tab", { name: "Schneiden" }));
  expect(screen.getByLabelText("Ohne Ton")).toBeChecked();
});
