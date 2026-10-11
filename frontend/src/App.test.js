import { render, screen, fireEvent } from '@testing-library/react';
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
  const exportMute = screen.getByLabelText(/ohne Ton/);
  fireEvent.click(exportMute);
  expect(exportMute).toBeChecked();
  expect(playerMute).not.toBeChecked();

  // Export-Lautstärke ändert die Vorschau-Lautstärke nicht
  fireEvent.click(exportMute);
  fireEvent.change(screen.getByLabelText("Export-Lautstärke"), { target: { value: "2" } });
  expect(screen.getByLabelText("Vorschau-Lautstärke")).toHaveValue("1");
  expect(document.querySelector("video").volume).toBe(1);
});
