import React, { useState } from 'react';

const UploadForm = () => {
  const [videoFile, setVideoFile] = useState(null);
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [response, setResponse] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!videoFile) return alert("Bitte wähle eine Videodatei aus.");

    const formData = new FormData();
    formData.append('video', videoFile);
    formData.append('startTime', startTime);
    formData.append('endTime', endTime);

    try {
      const res = await fetch('http://localhost:9000/upload', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      setResponse(data);
    } catch (error) {
      console.error('Fehler beim Upload:', error);
      setResponse({ status: 'error', message: 'Upload fehlgeschlagen' });
    }
  };

  return (
    <div style={{ padding: '20px' }}>
      <h2>Video Upload</h2>
      <form onSubmit={handleSubmit}>
        <div>
          <input type="file" accept="video/*" onChange={e => setVideoFile(e.target.files[0])} />
        </div>
        <div>
          <input type="number" placeholder="Startzeit (ms)" value={startTime} onChange={e => setStartTime(e.target.value)} />
        </div>
        <div>
          <input type="number" placeholder="Endzeit (ms)" value={endTime} onChange={e => setEndTime(e.target.value)} />
        </div>
        <button type="submit">Hochladen</button>
      </form>

      {response && (
        <div style={{ marginTop: '20px' }}>
          <pre>{JSON.stringify(response, null, 2)}</pre>
          {response.status === 'success' && (
            <video controls src={`http://localhost:9000${response.processedVideo}`} style={{ maxWidth: '100%' }} />
          )}
        </div>
      )}
    </div>
  );
};

export default UploadForm;
