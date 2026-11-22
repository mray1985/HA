import { useState } from 'react';
import { QUESTIONS, TERMS } from './learning';

export function TaxGame() {
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState<number | null>(null);
  const [score, setScore] = useState(0);
  const [done, setDone] = useState(false);
  const q = QUESTIONS[index];
  return <section className="ha-learning"><h2>Win the tax game.</h2><p>Practice decisions. Earn understanding. Your real return stays separate.</p>
    <div className="ha-game"><p>Question {index + 1} of {QUESTIONS.length} · {score} points</p>
      {done ? <><h3>You completed the game.</h3><p>{score} of {QUESTIONS.length * 100} points. Review the Taxtionary and try again.</p><button onClick={() => { setIndex(0); setAnswer(null); setScore(0); setDone(false); }}>Play again</button></> : <>
        <h3>{q.question}</h3><div className="ha-answers">{q.options.map((option, i) => <button key={option} disabled={answer !== null} className={answer === i ? 'selected' : ''} onClick={() => { setAnswer(i); if (i === q.answer) setScore(s => s + 100); }}>{option}</button>)}</div>
        {answer !== null && <div role="status"><h4>{answer === q.answer ? 'Correct. +100 points' : 'Keep learning.'}</h4><p>{q.why}</p><button onClick={() => { if (index + 1 === QUESTIONS.length) setDone(true); else { setIndex(i => i + 1); setAnswer(null); } }}>{index + 1 === QUESTIONS.length ? 'See results' : 'Next question'}</button></div>}
      </>}
    </div></section>;
}

export function Taxtionary() {
  const [query, setQuery] = useState('');
  const matches = TERMS.filter(t => `${t.term} ${t.text}`.toLowerCase().includes(query.toLowerCase().trim()));
  return <section className="ha-learning"><h2>Taxtionary</h2><p>Tax words, in everyday language.</p><label>Find a tax word<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Try deduction, credit, withholding…" /></label>
    <p role="status">{matches.length} definitions</p><dl className="ha-definitions">{matches.map(t => <div key={t.term}><dt>{t.term}</dt><dd>{t.text} <a href={t.source} target="_blank" rel="noreferrer">IRS source</a></dd></div>)}</dl>{!matches.length && <p>No matching word. Try another search.</p>}</section>;
}
