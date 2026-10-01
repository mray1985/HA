/**
 * Return tab: the return's IRS forms, filled from the engine. The sidebar
 * lists the forms that apply; the viewer shows the chosen form and accepts
 * a preparer's corrections on editable lines (audited by the case store).
 */

import FormSidebar from '../formsMode/FormSidebar';
import FormsMode from '../formsMode/FormsMode';

export default function ReturnPanel() {
  return (
    <div className="flex flex-1 min-h-0 w-full" style={{ height: 'calc(100vh - 7.5rem)' }}>
      <aside className="w-72 shrink-0 border-r border-slate-700 bg-surface-800 overflow-y-auto p-3">
        <FormSidebar />
      </aside>
      <FormsMode />
    </div>
  );
}
