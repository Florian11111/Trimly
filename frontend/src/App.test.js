import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import App from './App';

test('renders the dropzone', () => {
  render(<App />);
  expect(screen.getByText(/Ziehe eine Videodatei hierher/i)).toBeInTheDocument();
});

test('dropping a video uploads it to /store', () => {
  const opened = [];
  const sent = [];
  class FakeXHR {
    upload = {};
    open(method, url) { opened.push([method, url]); }
    send(body) { sent.push(body); }
    abort() {}
  }
  const origXHR = window.XMLHttpRequest;
  window.XMLHttpRequest = FakeXHR;
  URL.createObjectURL = jest.fn(() => 'blob:video');
  URL.revokeObjectURL = jest.fn();

  render(<App />);
  const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
  fireEvent.drop(screen.getByText(/Ziehe eine Videodatei hierher/i).parentElement, {
    dataTransfer: { files: [file] },
  });

  expect(opened).toEqual([['POST', 'http://localhost:9000/store']]);
  expect(sent[0].get('video')).toBe(file);
  window.XMLHttpRequest = origXHR;
});

test('file dialog starts in the Videos folder when supported', async () => {
  const picker = jest.fn(() => Promise.reject(Object.assign(new Error('abort'), { name: 'AbortError' })));
  window.showOpenFilePicker = picker;

  render(<App />);
  fireEvent.click(screen.getByText(/Ziehe eine Videodatei hierher/i));

  expect(picker).toHaveBeenCalledWith(expect.objectContaining({ startIn: 'videos', id: 'trimly-videos' }));
  delete window.showOpenFilePicker;
});

test('preview and export audio controls are independent', () => {
  window.XMLHttpRequest = class { upload = {}; open() {} send() {} abort() {} };
  URL.createObjectURL = jest.fn(() => 'blob:video');
  URL.revokeObjectURL = jest.fn();

  render(<App />);
  fireEvent.drop(screen.getByText(/Ziehe eine Videodatei hierher/i).parentElement, {
    dataTransfer: { files: [new File(['x'], 'clip.mp4', { type: 'video/mp4' })] },
  });

  const playerMute = screen.getByLabelText(/stumm/);
  const output = screen.getByLabelText("Ausgabe");
  fireEvent.change(output, { target: { value: "video" } });
  expect(screen.getByLabelText("Export-Lautstärke")).toBeDisabled();
  expect(playerMute).not.toBeChecked();

  // Export-Lautstärke ändert die Vorschau-Lautstärke nicht
  fireEvent.change(output, { target: { value: "both" } });
  fireEvent.change(screen.getByLabelText("Export-Lautstärke"), { target: { value: "2" } });
  expect(screen.getByLabelText("Vorschau-Lautstärke")).toHaveValue("1");
  expect(document.querySelector("video").volume).toBe(1);
});

test('editor tab opens and hides the trim view', () => {
  window.XMLHttpRequest = class { upload = {}; open() {} send() {} abort() {} };
  URL.createObjectURL = jest.fn(() => 'blob:video');
  URL.revokeObjectURL = jest.fn();

  render(<App />);
  fireEvent.drop(screen.getByText(/Ziehe eine Videodatei hierher/i).parentElement, {
    dataTransfer: { files: [new File(['x'], 'clip.mp4', { type: 'video/mp4' })] },
  });
  fireEvent.click(screen.getByText(/Editor/));
  // ohne geladene Metadaten (jsdom) zeigt der Editor einen Hinweis
  expect(screen.getByText(/Lade zuerst ein Video/)).toBeInTheDocument();
  expect(document.querySelector('.dropzone-wrapper')).toHaveStyle('display: none');
});

test('failed upload is retried on preview, audio-only is sent as output=audio', async () => {
  const xhrs = [];
  window.XMLHttpRequest = class {
    upload = {};
    constructor() { xhrs.push(this); }
    open(method, url) { this.url = url; }
    send(body) { this.body = body; }
    abort() {}
  };
  URL.createObjectURL = jest.fn(() => 'blob:video');
  URL.revokeObjectURL = jest.fn();
  const origFetch = global.fetch;
  global.fetch = jest.fn(() => Promise.resolve({ json: () => Promise.resolve({ status: 'error', message: 'x' }) }));

  render(<App />);
  const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
  fireEvent.drop(screen.getByText(/Ziehe eine Videodatei hierher/i).parentElement, {
    dataTransfer: { files: [file] },
  });
  // Server war nicht erreichbar
  await act(async () => xhrs[0].onerror());
  expect(screen.getByText(/Server nicht erreichbar/)).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Ausgabe'), { target: { value: 'audio' } });
  fireEvent.click(screen.getByText('Preview'));
  // Preview lädt dieselbe Datei erneut hoch
  expect(xhrs).toHaveLength(2);
  expect(xhrs[1].body.get('video')).toBe(file);
  xhrs[1].status = 200;
  xhrs[1].responseText = JSON.stringify({ status: 'success', originalId: 'abc' });
  await act(async () => xhrs[1].onload());

  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  const body = global.fetch.mock.calls[0][1].body;
  expect(body.get('originalId')).toBe('abc');
  expect(body.get('output')).toBe('audio');
  global.fetch = origFetch;
});
