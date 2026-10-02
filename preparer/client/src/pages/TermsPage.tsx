import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { LEGAL } from './legal';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-lg font-semibold text-white mt-6 mb-3">{title}</h2>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

const COMPONENTS: Array<[string, string]> = [
  ['llama.cpp (runs the local models)', 'MIT'],
  ['Qwen3.5-0.8B (reader model)', 'Apache-2.0'],
  ['GLM-OCR (second reader model)', 'MIT'],
  ['Tesseract.js (text recognition)', 'Apache-2.0'],
  ['PDF.js and pdf-lib (reading and filling PDFs)', 'Apache-2.0 and MIT'],
  ['Syncfusion Essential Studio (PDF viewer and charts)', 'Commercial license held by us; not licensed to you for other use'],
];

export default function TermsPage() {
  const navigate = useNavigate();
  const privacy = (
    <button onClick={() => navigate('/privacy')} className="text-HATaxService-blue-400 hover:text-HATaxService-blue-300 underline">Privacy Policy</button>
  );
  const mail = LEGAL.contactEmail
    ? <a href={`mailto:${LEGAL.contactEmail}`} className="text-HATaxService-blue-400 hover:text-HATaxService-blue-300 underline">{LEGAL.contactEmail}</a>
    : <>write to {LEGAL.company}, {LEGAL.address}</>;

  return (
    <div className="min-h-screen bg-surface-900">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-4 h-4" />
          <span className="text-sm">Back</span>
        </button>

        <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2">HA Tax Preparer — Terms of Use</h1>
        <p className="text-slate-400 text-xs mb-8">Effective {LEGAL.effective}</p>
        {!LEGAL.confirmed && (
          <p className="text-amber-300 text-xs border border-amber-500/30 bg-amber-500/10 rounded-lg px-3 py-2 -mt-4 mb-8">
            Draft for testing: this page has not yet been reviewed by counsel.
          </p>
        )}

        <div className="space-y-6 text-slate-300 text-sm leading-relaxed">
          <div className="card bg-HATaxService-blue-600/10 border-HATaxService-blue-600/30">
            <h3 className="text-base font-semibold text-HATaxService-blue-300 mb-2">The short version</h3>
            <p>
              HA Tax Preparer is a tool for tax professionals. You are the preparer: you review and sign every return, you keep
              your clients&apos; information safe on your computer, and you meet the rules for preparers. The app keeps that information
              on your computer and never sends it to us. It holds back what it cannot read or compute with confidence, rather than
              guessing — and it can still be wrong, so check its work.
            </p>
          </div>

          <Section title="1. This agreement">
            <p>
              These terms are an agreement between {LEGAL.company} (&ldquo;we&rdquo;, &ldquo;us&rdquo;) and the tax professional or firm that
              installs or uses HA Tax Preparer (&ldquo;you&rdquo;). By creating an account or using the app you accept them. If you accept
              for a firm, you confirm you may bind it, and the firm is responsible for its staff&apos;s use. The {privacy} is part of
              these terms.
            </p>
          </Section>

          <Section title="2. Who may use the app">
            <p>
              The app is licensed for preparing tax returns in the course of a tax practice. Each person who uses it needs their own
              seat and sign-in, and must hold any credential the law requires of them — a preparer who prepares returns for
              compensation needs a Preparer Tax Identification Number (PTIN).
            </p>
          </Section>

          <Section title="3. Your license">
            <p>
              While your seat is active we grant you a non-exclusive, non-transferable license to install and use the app for your
              practice. A seat runs through April 15 following the season in which it is activated. {/* TODO: the seat price and refund policy. */}
              You may not resell, sublicense or share the app or a seat; copy it except for backups; or reverse engineer it except
              as the law allows despite this limit. We keep all rights not granted here.
            </p>
            <p>The app includes third-party components under their own licenses:</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <tbody>
                  {COMPONENTS.map(([name, license]) => (
                    <tr key={name} className="border-b border-slate-800 align-top">
                      <td className="py-2 pr-4">{name}</td>
                      <td className="py-2 text-slate-400">{license}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="4. You are the preparer">
            <ul className="list-disc pl-5 space-y-1">
              <li>The app is software, not a tax advisor, and does not give tax, legal or accounting advice. Every return is yours: you apply your professional judgment, review it, and sign it as its preparer.</li>
              <li>Your professional duties stay yours, including Circular 230 if you practice before the IRS, and the due-diligence requirements for the credits and head-of-household status the law lists (IRC §6695(g), Form 8867).</li>
              <li>IRC §6107 requires you to give each client a completed copy of the return by the time it is presented for signature, and to keep a copy, or a list of the taxpayers&apos; names and identifying numbers, for 3 years after the close of the return period.</li>
              <li>The app does not file returns. You file each return by the method you choose.</li>
            </ul>
          </Section>

          <Section title="5. What the app does, and its limits">
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <span className="text-white">Local AI.</span> Documents and client replies are read by AI models running on your computer. A value is used only when the
                document&apos;s own text or a second reading confirms it; anything else is held for you. Readings can still be wrong: check each value against the
                document before you approve a return.
              </li>
              <li>
                <span className="text-white">Fails closed.</span> When the app cannot compute something to the official rules — a form, a worksheet, a state rule —
                it says so and holds the return instead of estimating. Prepare those parts outside the app.
              </li>
              <li>
                <span className="text-white">Coverage.</span> The forms, schedules and states the app supports, and the tax years it computes, are listed with the app.
                Tax law changes; install the updates we publish for the season.
              </li>
            </ul>
          </Section>

          <Section title="6. Your clients' information">
            <p>The app keeps your clients&apos; information on your computer. Protecting it is your duty under federal law:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <span className="text-white">Safeguards Rule.</span> As a tax preparer you are a financial institution under the FTC Safeguards Rule (16 CFR Part 314).
                You must keep a written information security program: a qualified individual to run it, a risk assessment, access controls,
                encryption of customer information, multi-factor authentication for anyone accessing it, secure disposal no later than two years
                after last use (unless needed for business or required by law), staff training, and an incident response plan. Firms with
                information on fewer than 5,000 consumers are exempt from some of these elements (16 CFR 314.6). The app&apos;s encryption, locks and
                local-only storage help; your program must also cover this computer, its backups and every file you export. IRS Publications 4557
                and 5708 explain how.
              </li>
              <li>
                <span className="text-white">Privacy notices.</span> Give your clients the privacy notices Regulation P requires (12 CFR Part 1016).
              </li>
              <li>
                <span className="text-white">IRC §7216.</span> You may not disclose your clients&apos; tax return information, or use it for anything but preparing their returns,
                without their written consent, except as Treas. Reg. §301.7216-2 permits. A consent must be obtained before the disclosure or use, signed and dated,
                and carry the statements Rev. Proc. 2013-14 prescribes; without a stated duration it lasts one year. Knowing or reckless violation is a misdemeanor
                (a fine of up to $1,000 and up to a year in prison), and IRC §6713 adds a civil penalty of $250 for each disclosure or use, up to $10,000 a year
                (higher where identity theft is involved).
              </li>
              <li>
                <span className="text-white">Data theft.</span> If client information is stolen, report it at once to your IRS Stakeholder Liaison and to the state tax agencies,
                notify the FTC within 30 days of discovering an event involving the unencrypted information of 500 or more people (16 CFR 314.4(j)), and follow your
                state&apos;s breach-notice laws.
              </li>
            </ul>
          </Section>

          <Section title="7. Our handling of tax return information">
            <p>
              Treasury regulations treat a company that develops software used to prepare returns as a tax return preparer for §7216 purposes
              (Treas. Reg. §301.7216-1(b)(2)(i)(B)). The app is built so that we never receive your clients&apos; information. If any reaches us — in a support
              request, for example — we use it only to help you, never disclose it, sell it or use it for marketing, and delete it once the request is closed.
              Do not send us client information; mask identifying numbers in anything you must send.
            </p>
          </Section>

          <Section title="8. Your passphrase and your data">
            <p>
              Your cases are encrypted with a key made from your passphrase, on your computer. We cannot recover a lost passphrase or restore deleted or lost
              data. Keep your passphrase safe and download the encrypted case file regularly.
            </p>
          </Section>

          <Section title="9. Warranty disclaimer">
            <p>
              The app is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the extent the law allows, we disclaim all warranties, express or implied,
              including merchantability, fitness for a particular purpose, accuracy and non-infringement. We do not warrant that the app is error-free, that
              it computes every situation, or that its readings of documents are correct.
            </p>
          </Section>

          <Section title="10. Limitation of liability">
            <p>
              To the extent the law allows, we are not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, lost data,
              or tax, penalties or interest assessed on any return; and our total liability for any claim about the app is limited to the fees you paid for it in the
              12 months before the claim. Some jurisdictions do not allow these limits, so they may not apply to you in full.
            </p>
          </Section>

          <Section title="11. Indemnification">
            <p>
              You will defend and indemnify us against claims by your clients or others arising from the returns you prepare, your practice, or your breach of
              these terms or of the laws in Section 6, except to the extent a claim is caused by our breach of these terms.
            </p>
          </Section>

          <Section title="12. Ending the license">
            <p>
              You may stop using the app at any time. We may suspend or end your license if you breach these terms. When it ends, stop using the app; your data stays
              on your computer and remains yours, and Sections 4, 6, 7 and 9 to 14 continue.
            </p>
          </Section>

          <Section title="13. Governing law">
            <p>
              These terms are governed by the laws of {LEGAL.governingLaw}, without regard to its conflict-of-laws rules, and disputes will be resolved in its courts.
            </p>
          </Section>

          <Section title="14. General">
            <p>
              We may change these terms for a new version of the app; the version you install shows the terms that apply, with their effective date. If a provision
              is unenforceable, the rest stays in effect. These terms and the Privacy Policy are the whole agreement about the app.
            </p>
          </Section>

          <Section title="15. Contact">
            <p>Questions about these terms: {mail}.</p>
          </Section>
        </div>

        <div className="text-xs text-slate-500 mt-12 flex items-center justify-center gap-3">
          <button onClick={() => navigate('/privacy')} className="text-slate-400 hover:text-slate-300 transition-colors">Privacy Policy</button>
          <span className="text-slate-700">&middot;</span>
          <button onClick={() => navigate('/preparer')} className="text-slate-400 hover:text-slate-300 transition-colors">Back to the cases</button>
        </div>
      </div>
    </div>
  );
}
