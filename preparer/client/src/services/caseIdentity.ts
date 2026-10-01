/**
 * The taxpayer's identity from the case's documents (work order §12, §13).
 *
 * Each form names a person (the W-2 employee, a 1099 recipient, the 1098
 * borrower, the SSA-1099 beneficiary). People are told apart by a confirmed
 * SSN; a masked TIN's last four digits with the last name, or a name alone,
 * joins the person it matches. Then:
 *
 * - the return's empty identity fields — the taxpayer's SSN, name and
 *   address, and the spouse's name once the spouse's SSN is on the return —
 *   are filled from readings an independent reader confirmed, and audited;
 *   nothing the preparer entered is ever replaced;
 * - two people with SSNs and no taxpayer yet: the preparer picks the
 *   taxpayer (the other becomes the spouse);
 * - a person who is neither the taxpayer nor the spouse, a name that differs
 *   from the return's for the same SSN, differing addresses, and readings no
 *   second reader confirmed are review items, each with its one-click answer.
 */

import type { TaxReturn } from '@hatax/engine';
import { identityKeyText, type IngestedDocument, type PartyIdentity, type PersonName, type USAddress } from '@hatax/local-ai';
import { getReturn, updateReturn } from '../api/client';
import { appendAudit } from './caseAudit';

export interface IdentitySource {
  documentId: string;
  fileName: string;
  index: number;
  identity: PartyIdentity;
}

export interface Person {
  key: string;
  /** Confirmed full SSN/ITIN, 9 digits. */
  tin?: string;
  tinLastFour?: string;
  /** Confirmed, split name; absent when the documents disagree or none could be split. */
  name?: PersonName;
  /** The name as printed, for showing. */
  printedName?: string;
  /** Distinct confirmed addresses. */
  addresses: USAddress[];
  sources: IdentitySource[];
}

export type IdentityRole = 'taxpayer' | 'spouse';

/** Review items the identity check raises, with the answer each takes. */
export interface IdentityItem {
  id: string;
  message: string;
  documentId?: string;
  action?:
    | { kind: 'use_identity'; documentId: string; index: number; part: 'tin' | 'name' | 'address'; role: IdentityRole; shown: string }
    | { kind: 'identity_person'; purpose: 'taxpayer' | 'spouse'; options: Array<{ key: string; label: string }> }
    | { kind: 'choose_address'; options: Array<{ key: string; label: string }> };
}

const digits = (s: string | undefined) => {
  const d = (s ?? '').replace(/\D/g, '');
  return d.length === 9 ? d : undefined;
};
const upper = (s: string | undefined) => identityKeyText(s ?? '');
const nameKey = (n: PersonName) => `${upper(n.first)}|${upper(n.last)}`;
const addressKey = (a: USAddress) => `${upper(a.street)}|${a.zip.slice(0, 5)}`;
export const formatAddress = (a: USAddress) => `${a.street}, ${a.city}, ${a.state} ${a.zip}`;
const formatTin = (d: string) => `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;

export function identitySources(documents: readonly IngestedDocument[]): IdentitySource[] {
  return documents.flatMap((doc) => (doc.status === 'extracted' ? doc.identities ?? [] : []).flatMap((identity, index) =>
    identity ? [{ documentId: doc.documentId, fileName: doc.fileName, index, identity }] : []));
}

/** The people the documents name, one per confirmed SSN, or last four digits and last name, or name. */
export function peopleOnDocuments(sources: readonly IdentitySource[]): Person[] {
  const people: Person[] = [];
  const add = (person: Person, source: IdentitySource) => {
    person.sources.push(source);
    const id = source.identity;
    if (id.name?.confirmed && id.name.value) {
      const n = id.name.value;
      if (!person.name) person.name = n;
      else if (nameKey(person.name) !== nameKey(n)) person.name = undefined;
      else if (!person.name.middleInitial && n.middleInitial) person.name = n;
    }
    if (!person.printedName && id.name?.raw) person.printedName = id.name.raw.split(/\r?\n/)[0];
    if (id.address?.confirmed && id.address.value && !person.addresses.some((a) => addressKey(a) === addressKey(id.address!.value!))) {
      person.addresses.push(id.address.value);
    }
    person.tinLastFour ??= id.tinLastFour;
  };

  // 1. A confirmed SSN is the person.
  for (const s of sources) {
    const tin = s.identity.tin?.confirmed ? s.identity.tin.value : undefined;
    if (!tin) continue;
    let p = people.find((x) => x.tin === tin);
    if (!p) people.push((p = { key: `tin:${tin}`, tin, tinLastFour: tin.slice(5), addresses: [], sources: [] }));
    add(p, s);
  }
  // 2. Last four digits (and the last name, when printed), or 3. the name alone.
  for (const s of sources) {
    if (s.identity.tin?.confirmed) continue;
    const id = s.identity;
    const name = id.name?.confirmed ? id.name.value : null;
    const last = name ? upper(name.last) : undefined;
    let p: Person | undefined;
    if (id.tinLastFour) {
      p = people.find((x) => x.tinLastFour === id.tinLastFour && (!last || !x.name || upper(x.name.last) === last));
      if (!p) people.push((p = { key: `l4:${id.tinLastFour}:${last ?? ''}`, tinLastFour: id.tinLastFour, addresses: [], sources: [] }));
    } else if (name) {
      p = people.find((x) => x.name && nameKey(x.name) === nameKey(name));
      if (!p) people.push((p = { key: `name:${nameKey(name)}`, addresses: [], sources: [] }));
    } else continue;
    add(p, s);
  }
  return people;
}

function label(p: Person): string {
  const who = p.name ? [p.name.first, p.name.middleInitial, p.name.last].filter(Boolean).join(' ') : p.printedName ?? 'someone';
  const tin = p.tin ? ` (SSN ending ${p.tin.slice(5)})` : p.tinLastFour ? ` (TIN ending ${p.tinLastFour})` : '';
  const files = [...new Set(p.sources.map((s) => s.fileName))].join(', ');
  return `${who}${tin} — ${files}`;
}

function matches(p: Person, ssn: string | undefined, lastName: string | undefined): boolean {
  if (!ssn) return false;
  if (p.tin) return p.tin === ssn;
  if (!p.tinLastFour || p.tinLastFour !== ssn.slice(5)) return false;
  return !p.name || !lastName || upper(p.name.last) === upper(lastName);
}

function namePatch(role: IdentityRole, n: PersonName): Partial<TaxReturn> {
  return role === 'taxpayer'
    ? { firstName: n.first, lastName: n.last, ...(n.middleInitial ? { middleInitial: n.middleInitial } : {}), ...(n.suffix ? { suffix: n.suffix } : {}) }
    : { spouseFirstName: n.first, spouseLastName: n.last, ...(n.middleInitial ? { spouseMiddleInitial: n.middleInitial } : {}), ...(n.suffix ? { spouseSuffix: n.suffix } : {}) };
}

const addressPatch = (a: USAddress): Partial<TaxReturn> => ({ addressStreet: a.street, addressCity: a.city, addressState: a.state, addressZip: a.zip });

export interface IdentityPlan {
  /** Empty return fields filled from confirmed readings. */
  patch: Partial<TaxReturn>;
  /** What was filled, from which files, for the audit trail. */
  filled: string[];
  items: IdentityItem[];
  people: Person[];
}

export function planIdentity(tr: TaxReturn, documents: readonly IngestedDocument[]): IdentityPlan {
  const sources = identitySources(documents);
  const people = peopleOnDocuments(sources);
  const patch: Partial<TaxReturn> = {};
  const filled: string[] = [];
  const items: IdentityItem[] = [];
  const files = (p: Person) => [...new Set(p.sources.map((s) => s.fileName))].join(', ');

  let ssn = digits(tr.ssn);
  let taxpayer = people.find((p) => matches(p, ssn, tr.lastName));
  if (!ssn) {
    const withTin = people.filter((p) => p.tin);
    if (withTin.length === 1) taxpayer = withTin[0];
    else if (withTin.length === 0) {
      const named = people.filter((p) => p.name);
      if (named.length === 1 && people.length === 1) taxpayer = named[0];
    } else {
      items.push({
        id: 'identity:choose-taxpayer',
        message: `The documents are for ${withTin.length} people: ${withTin.map(label).join('; ')}. Choose the taxpayer; the other is entered as the spouse.`,
        action: { kind: 'identity_person', purpose: 'taxpayer', options: withTin.map((p) => ({ key: p.key, label: label(p) })) },
      });
    }
    if (taxpayer?.tin) {
      patch.ssn = taxpayer.tin;
      ssn = taxpayer.tin;
      filled.push(`SSN (${files(taxpayer)})`);
    }
  }
  const spouseSsn = digits(tr.spouseSsn);
  const spouse = people.find((p) => p !== taxpayer && matches(p, spouseSsn, tr.spouseLastName));

  if (taxpayer) {
    if (!tr.firstName && !tr.lastName && taxpayer.name) {
      Object.assign(patch, namePatch('taxpayer', taxpayer.name));
      filled.push(`name (${files(taxpayer)})`);
    }
    const addressEmpty = !tr.addressStreet && !tr.addressCity && !tr.addressState && !tr.addressZip;
    if (addressEmpty && taxpayer.addresses.length === 1) {
      Object.assign(patch, addressPatch(taxpayer.addresses[0]!));
      filled.push(`address (${files(taxpayer)})`);
    } else if (addressEmpty && taxpayer.addresses.length > 1) {
      items.push({
        id: 'identity:addresses',
        message: `The documents show ${taxpayer.addresses.length} addresses for the taxpayer: ${taxpayer.addresses.map(formatAddress).join('; ')}. Use the current one.`,
        action: { kind: 'choose_address', options: taxpayer.addresses.map((a) => ({ key: addressKey(a), label: formatAddress(a) })) },
      });
    }
    // A different last name for the same SSN: the IRS matches it against Social Security's records.
    const last = tr.lastName ?? (patch.lastName as string | undefined);
    if (taxpayer.name && last && upper(taxpayer.name.last) !== upper(last)) {
      items.push({ id: `identity:name:${taxpayer.key}`, documentId: taxpayer.sources[0]!.documentId,
        message: `${files(taxpayer)} name${taxpayer.sources.length === 1 ? 's' : ''} the taxpayer ${taxpayer.printedName ?? taxpayer.name.last}; the return has ${[tr.firstName, last].filter(Boolean).join(' ')}. The IRS checks the name against Social Security's records: use the name on the client's Social Security card.` });
    }
  }
  if (spouse?.name && !tr.spouseFirstName && !tr.spouseLastName) {
    Object.assign(patch, namePatch('spouse', spouse.name));
    filled.push(`spouse's name (${files(spouse)})`);
  }

  // People who are neither the taxpayer nor the spouse.
  if (ssn || taxpayer) {
    for (const p of people) {
      if (p === taxpayer || p === spouse) continue;
      if (!p.tin && !p.tinLastFour) continue;
      items.push({
        id: `identity:other:${p.key}`, documentId: p.sources[0]!.documentId,
        message: `${files(p)} ${p.sources.length === 1 ? 'is' : 'are'} for ${label(p).split(' — ')[0]}, who is not the taxpayer${spouseSsn ? ' or the spouse' : ''} on the return. ${p.tin && !spouseSsn ? 'Enter them as the spouse, or' : 'Check that it belongs on this return, or'} remove the document.`,
        ...(p.tin && !spouseSsn ? { action: { kind: 'identity_person' as const, purpose: 'spouse' as const, options: [{ key: p.key, label: label(p) }] } } : {}),
      });
    }
  }

  // Readings no second reader confirmed: the preparer checks them against the document.
  const after = { ...tr, ...patch };
  for (const s of sources) {
    const id = s.identity;
    const ref = { documentId: s.documentId, index: s.index };
    if (!digits(after.ssn) && id.tin && !id.tin.confirmed) {
      items.push({ id: `identity:unconfirmed:${s.documentId}#${s.index}:tin`, documentId: s.documentId,
        message: `${s.fileName} reads the ${id.formType === 'W-2' ? "employee's SSN (box a)" : "recipient's TIN"} as ${formatTin(id.tin.value)}, but no second reader confirmed it. Check it against the document.`,
        action: { kind: 'use_identity', ...ref, part: 'tin', role: 'taxpayer', shown: formatTin(id.tin.value) } });
    }
    if (!after.firstName && !after.lastName && id.name && !id.name.confirmed && id.name.value) {
      const shown = [id.name.value.first, id.name.value.middleInitial, id.name.value.last, id.name.value.suffix].filter(Boolean).join(' ');
      items.push({ id: `identity:unconfirmed:${s.documentId}#${s.index}:name`, documentId: s.documentId,
        message: `${s.fileName} reads the name as ${shown}, but no second reader confirmed it. Check it against the document.`,
        action: { kind: 'use_identity', ...ref, part: 'name', role: 'taxpayer', shown } });
    }
    if (!after.addressStreet && !after.addressCity && id.address && !id.address.confirmed && id.address.value) {
      const shown = formatAddress(id.address.value);
      items.push({ id: `identity:unconfirmed:${s.documentId}#${s.index}:address`, documentId: s.documentId,
        message: `${s.fileName} reads the address as ${shown}, but no second reader confirmed it. Check it against the document.`,
        action: { kind: 'use_identity', ...ref, part: 'address', role: 'taxpayer', shown } });
    }
  }
  return { patch, filled, items, people };
}

/** Fill the return's empty identity fields from the documents; returns what was filled. */
export function applyIdentityFromDocuments(returnId: string, documents: readonly IngestedDocument[]): string[] {
  const plan = planIdentity(getReturn(returnId), documents);
  if (Object.keys(plan.patch).length === 0) return [];
  updateReturn(returnId, plan.patch);
  appendAudit(returnId, { kind: 'decision', subject: 'Taxpayer identity', detail: `filled from confirmed readings: ${plan.filled.join('; ')}` });
  return plan.filled;
}

type Result = { ok: true } | { ok: false; error: string };

/** Use one document's reading the preparer checked against the document. */
export function applyIdentityReading(returnId: string, documents: readonly IngestedDocument[], documentId: string, index: number, part: 'tin' | 'name' | 'address', role: IdentityRole): Result {
  const id = documents.find((d) => d.documentId === documentId)?.identities?.[index];
  if (!id) return { ok: false, error: 'That reading is no longer on the case.' };
  let patch: Partial<TaxReturn>;
  if (part === 'tin' && id.tin) patch = role === 'taxpayer' ? { ssn: id.tin.value } : { spouseSsn: id.tin.value };
  else if (part === 'name' && id.name?.value) patch = namePatch(role, id.name.value);
  else if (part === 'address' && id.address?.value) patch = addressPatch(id.address.value);
  else return { ok: false, error: 'That reading has no value to use.' };
  updateReturn(returnId, patch);
  const file = documents.find((d) => d.documentId === documentId)?.fileName ?? documentId;
  appendAudit(returnId, { kind: 'decision', subject: 'Taxpayer identity', detail: `used the ${role}'s ${part === 'tin' ? 'SSN' : part} read from ${file}, checked by the preparer against the document` });
  return { ok: true };
}

/** Put a person the documents name on the return as the taxpayer (the only other person becomes the spouse) or as the spouse. */
export function setPersonOnReturn(returnId: string, documents: readonly IngestedDocument[], key: string, role: IdentityRole): Result {
  const tr = getReturn(returnId);
  const people = peopleOnDocuments(identitySources(documents));
  const person = people.find((p) => p.key === key);
  if (!person?.tin) return { ok: false, error: 'That person is no longer on the case.' };
  const patch: Partial<TaxReturn> = {};
  const put = (p: Person, r: IdentityRole) => {
    if (r === 'taxpayer') {
      patch.ssn = p.tin;
      if (p.name && !tr.firstName && !tr.lastName) Object.assign(patch, namePatch('taxpayer', p.name));
      if (p.addresses.length === 1 && !tr.addressStreet) Object.assign(patch, addressPatch(p.addresses[0]!));
    } else {
      patch.spouseSsn = p.tin;
      if (p.name && !tr.spouseFirstName && !tr.spouseLastName) Object.assign(patch, namePatch('spouse', p.name));
    }
  };
  put(person, role);
  const others = people.filter((p) => p !== person && p.tin);
  if (role === 'taxpayer' && others.length === 1 && !digits(tr.spouseSsn)) put(others[0]!, 'spouse');
  updateReturn(returnId, patch);
  appendAudit(returnId, { kind: 'decision', subject: 'Taxpayer identity', detail: `entered ${label(person)} as the ${role}${role === 'taxpayer' && others.length === 1 ? `, and ${label(others[0]!)} as the spouse` : ''}` });
  return { ok: true };
}

/** Use one of the addresses the documents show. */
export function applyAddress(returnId: string, documents: readonly IngestedDocument[], key: string): Result {
  const address = peopleOnDocuments(identitySources(documents)).flatMap((p) => p.addresses).find((a) => addressKey(a) === key);
  if (!address) return { ok: false, error: 'That address is no longer on the case.' };
  updateReturn(returnId, addressPatch(address));
  appendAudit(returnId, { kind: 'decision', subject: 'Taxpayer identity', detail: `used the address ${formatAddress(address)}` });
  return { ok: true };
}

/** The case's name as the dashboard shows it. */
export function clientNameOf(tr: TaxReturn): string {
  const names = [[tr.firstName, tr.lastName], [tr.spouseFirstName, tr.spouseLastName]]
    .map((p) => p.filter(Boolean).join(' '))
    .filter(Boolean);
  return names.join(' & ') || 'New client';
}
