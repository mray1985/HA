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

const STORED: Array<[string, string]> = [
  ['Your sign-in account: email, name, password (stored only as a bcrypt hash), role, seat status and sign-in sessions', "A database in the app's data folder in your Windows user profile"],
  ["Your clients' cases: names, SSNs and ITINs, dates of birth, addresses, income, deductions, dependents, refund bank accounts, your review decisions and each case's audit trail", "The app's local storage, encrypted with your vault key"],
  ['The documents you drop on a case (PDFs, scans, photos)', "The app's local database, encrypted with your vault key, so the review can show the page a value came from"],
  ["The local AI's readings: each value read, the page and box it came from, and which model read it, when and how fast", 'With the case, encrypted with your vault key'],
  ['The unlocked vault key, while a session lasts', 'Kept as a key that cannot be read back out, and forgotten when you lock, sign out or close the app, and after 12 hours'],
  ["The case file you download from the dashboard (every case's return)", 'Wherever you save it, encrypted with the download password you choose'],
  ['Filing packets, form PDFs and review packages you download', 'Wherever you save them, as ordinary files: the app does not encrypt them'],
];

export default function PrivacyPage() {
  const navigate = useNavigate();
  const mail = <a href={`mailto:${LEGAL.contactEmail}`} className="text-HATaxService-blue-400 hover:text-HATaxService-blue-300 underline">{LEGAL.contactEmail}</a>;

  return (
    <div className="min-h-screen bg-surface-900">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors mb-8">
          <ArrowLeft className="w-4 h-4" />
          <span className="text-sm">Back</span>
        </button>

        <h1 className="text-2xl sm:text-3xl font-bold text-white mb-2">HA Tax Preparer — Privacy Policy</h1>
        <p className="text-slate-400 text-xs mb-8">Effective {LEGAL.effective}</p>

        <div className="space-y-6 text-slate-300 text-sm leading-relaxed">
          <div className="card bg-HATaxService-blue-600/10 border-HATaxService-blue-600/30">
            <h3 className="text-base font-semibold text-HATaxService-blue-300 mb-2">The short version</h3>
            <p>
              HA Tax Preparer is desktop software for tax professionals. Everything you and your clients&apos; documents put into it
              stays on the computer it is installed on, encrypted with a key made from your passphrase. Documents are read by AI
              models that run on that computer. The app sends nothing to us or to anyone else, so we never receive your clients&apos;
              tax return information.
            </p>
          </div>

          <p>
            This policy covers the HA Tax Preparer application (&ldquo;the app&rdquo;) licensed by {LEGAL.company} (&ldquo;we&rdquo;, &ldquo;us&rdquo;) to tax
            professionals and their firms (&ldquo;you&rdquo;). Your clients&apos; information is yours to hold and protect: as a tax
            preparer you are a &ldquo;financial institution&rdquo; under the Gramm-Leach-Bliley Act, and the app is a tool you use to do it.
            Section 6 lists what the law asks of you.
          </p>

          <Section title="1. What the app keeps, and where">
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-slate-700">
                    <th className="text-left py-2 pr-4 text-slate-400 font-medium">Information</th>
                    <th className="text-left py-2 text-slate-400 font-medium">Where it is kept (always on this computer)</th>
                  </tr>
                </thead>
                <tbody>
                  {STORED.map(([what, where]) => (
                    <tr key={what} className="border-b border-slate-800 align-top">
                      <td className="py-2 pr-4">{what}</td>
                      <td className="py-2">{where}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section title="2. What leaves the computer">
            <p className="font-semibold text-HATaxService-orange-300">Nothing.</p>
            <p>
              The app&apos;s server runs inside the app and accepts connections only from this computer (127.0.0.1). The AI models
              that read documents and client replies (Qwen3.5-0.8B and GLM-OCR) run on this computer through llama.cpp; no
              document, reply or value is sent to an AI service. Text recognition, the IRS and state form PDFs, fonts and the
              PDF viewer all ship with the app.
            </p>
            <p>
              The app does not send analytics, telemetry or crash reports, does not check for updates or download models, and
              uses no cookies for tracking. Its content security policy lets its pages connect only to the app itself.
            </p>
            <p>
              A link to an outside site, such as IRS.gov, opens in your web browser; that site&apos;s own privacy policy applies
              there.
            </p>
          </Section>

          <Section title="3. What we receive">
            <p>
              Through the app: nothing about you or your clients. We cannot see, recover or restore anything in your vault.
            </p>
            <p>
              If you write to us, we receive what you send. Do not send us your clients&apos; information. If a support question
              needs part of a return, send it with Social Security numbers and other identifying numbers masked. Anything of a
              client&apos;s that reaches us anyway is tax return information under IRC §7216: we use it only to answer you, never
              disclose it or use it for anything else, and delete it once your question is answered.
            </p>
            <p>
              {/* TODO: describe the seat purchase once billing is chosen: what the payment processor receives, and what we keep. */}
              Buying a seat: the purchase details you give us (name, email, billing information) are used to bill you and keep
              your license records, and are never combined with client information, which we do not have.
            </p>
          </Section>

          <Section title="4. How the app protects it">
            <ul className="list-disc pl-5 space-y-1">
              <li>Cases, documents and readings are encrypted with AES-256-GCM. The key is made from your passphrase with PBKDF2 (SHA-256, 600,000 iterations); the passphrase itself is never stored.</li>
              <li>The app locks after 15 minutes without use and 30 seconds after its window is hidden. Work under way, such as documents being read, finishes saving before the key is dropped.</li>
              <li>Sign-in passwords are kept only as bcrypt hashes.</li>
              <li>Every change to a case — a value corrected, a review decision, a form placed — is kept in the case&apos;s audit trail.</li>
              <li>A lost passphrase cannot be recovered by you or by us, and the encrypted cases cannot be opened without it. Keep your passphrase safe and keep backups (Section 5).</li>
            </ul>
          </Section>

          <Section title="5. Keeping, backing up and deleting">
            <p>
              You decide how long the app keeps a case. Deleting a case removes its return, documents, source files, readings,
              review record and audit trail. Uninstalling the app leaves its data folder in your Windows user profile, which holds
              the encrypted cases and the sign-in database: delete that folder to remove everything the app kept.
            </p>
            <p>
              The law sets limits both ways. IRC §6107(b) requires a preparer to keep a completed copy of each return, or a list of
              the taxpayers&apos; names and identifying numbers, for 3 years after the close of the return period. The FTC Safeguards Rule
              (16 CFR 314.4(c)(6)) requires customer information to be disposed of securely no later than two years after it was last
              used for the customer, unless it is needed for a legitimate business purpose or the law requires keeping it.
            </p>
            <p>
              Because everything stays on this computer, a failed disk or a lost passphrase loses it. Download the encrypted case
              file regularly; it holds every case&apos;s return but not the source documents or audit trails, so keep the documents
              as your security plan and §6107 require.
            </p>
          </Section>

          <Section title="6. What the law asks of you">
            <p>
              The app helps you protect client information, but the duties are yours as the preparer. In short (the Terms of Use say more):
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <span className="text-white">A written information security program.</span> Tax preparers are financial institutions under the FTC Safeguards
                Rule (16 CFR Part 314; tax preparation is listed in 314.2(h)(2)(viii)). Your program covers this computer, its backups and
                every file you export. See IRS Publication 4557 and Publication 5708.
              </li>
              <li>
                <span className="text-white">Privacy notices to your clients</span> under the Gramm-Leach-Bliley Act&apos;s Regulation P (12 CFR Part 1016).
              </li>
              <li>
                <span className="text-white">Consent before using or disclosing tax return information</span> for anything other than preparing the return
                (IRC §7216; Treas. Reg. §301.7216-3; Rev. Proc. 2013-14).
              </li>
              <li>
                <span className="text-white">Reporting a breach.</span> Report data theft to your IRS Stakeholder Liaison and the state tax agencies, and notify
                the FTC within 30 days of discovering an event involving the unencrypted information of 500 or more people (16 CFR 314.4(j)).
              </li>
            </ul>
          </Section>

          <Section title="7. Children">
            <p>
              The app is for tax professionals, not children. A return can include information about a client&apos;s children, such as
              dependents; it stays on this computer like everything else.
            </p>
          </Section>

          <Section title="8. Changes to this policy">
            <p>
              If a version of the app changes what it keeps or sends, this policy changes with it, with a new effective date. A
              version that sends anything off the computer would say so here first.
            </p>
          </Section>

          <Section title="9. Contact">
            <p>Questions about this policy or about the app&apos;s handling of information: {mail}.</p>
          </Section>
        </div>

        <div className="text-xs text-slate-500 mt-12 flex items-center justify-center gap-3">
          <button onClick={() => navigate('/terms')} className="text-slate-400 hover:text-slate-300 transition-colors">Terms of Use</button>
          <span className="text-slate-700">&middot;</span>
          <button onClick={() => navigate('/preparer')} className="text-slate-400 hover:text-slate-300 transition-colors">Back to the cases</button>
        </div>
      </div>
    </div>
  );
}
