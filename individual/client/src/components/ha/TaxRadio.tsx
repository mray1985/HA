import { useEffect, useRef, useState } from 'react';
import { Play, Pause, Radio, Square } from 'lucide-react';
import { LESSONS } from './learning';

export default function TaxRadio({ lesson, onLesson }: { lesson: number; onLesson: (n: number) => void }) {
  const [playing, setPlaying] = useState(false);
  const [message, setMessage] = useState('');
  const [transcript, setTranscript] = useState(false);
  const [audioUrl, setAudioUrl] = useState('');
  const [audioName, setAudioName] = useState('');
  const audio = useRef<HTMLAudioElement>(null);
  const stop = () => { if (audio.current) { audio.current.pause(); audio.current.currentTime = 0; } setPlaying(false); };
  useEffect(() => { stop(); setAudioUrl(''); setAudioName(''); }, [lesson]);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  function play() {
    void audio.current?.play().then(() => setMessage('')).catch(() => { setMessage('Unable to play this recording. Try the transcript or another audio file.'); setTranscript(true); });
  }
  return <aside className="ha-radio" aria-label="HA Tax Radio"><div className="ha-radio-controls"><h2><Radio size={25} /> HA Tax Radio</h2>
    <button aria-label={playing ? 'Pause lesson' : 'Play lesson'} onClick={() => { if (playing) audio.current?.pause(); else play(); }}>{playing ? <Pause size={20} /> : <Play size={20} />}</button>
    <button aria-label="Stop lesson" onClick={stop}><Square size={17} /></button>
    <label className="ha-radio-select">General education<select aria-label="Radio lesson" value={lesson} onChange={e => onLesson(Number(e.target.value))}>{LESSONS.map((l, i) => <option key={l.title} value={i}>{l.title}</option>)}</select></label>
    <button onClick={() => setTranscript(v => !v)} aria-expanded={transcript}>Transcript & audio</button></div>
    <audio ref={audio} controls preload="metadata" src={audioUrl || `/ha-radio/lesson-${lesson}.wav`} aria-label={audioName || LESSONS[lesson].title} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => setMessage('Audio could not load. The transcript is available.')} />
    {message && <p role="status">{message}</p>}{transcript && <div className="ha-radio-details"><p>{LESSONS[lesson].text}</p><label>Play your own HA recording<input type="file" accept="audio/*" onChange={e => { const f = e.target.files?.[0]; if (f) { stop(); setAudioUrl(URL.createObjectURL(f)); setAudioName(f.name); } }} /></label>{audioName && <p>{audioName}</p>}</div>}
  </aside>;
}
