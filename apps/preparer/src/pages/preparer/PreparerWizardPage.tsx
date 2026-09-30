import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getReturn } from '../../api/client';
import { useTaxReturnStore, flushAutoSave } from '../../store/taxReturnStore';
import { useChatStore } from '../../store/chatStore';
import WizardLayout from '../../components/layout/WizardLayout';
import StepRenderer from '../../components/steps/StepRenderer';
import { toast } from 'sonner';

export default function PreparerWizardPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  useEffect(() => {
    if (!id) {
      navigate('/preparer', { replace: true });
      return;
    }
    try {
      const { setReturn, setReturnId, setStartTime, goToStep, setCurrentStep } = useTaxReturnStore.getState();
      const hydrateChat = useChatStore.getState().hydrateForReturn;
      const data = getReturn(id);
      setReturn(data);
      setReturnId(id);
      hydrateChat(id);

      useTaxReturnStore.setState({ viewMode: 'wizard' });

      const savedHighest = typeof (data as any).highestStepVisited === 'number'
        ? (data as any).highestStepVisited
        : (typeof data.currentStep === 'number' ? data.currentStep : 0);
      useTaxReturnStore.setState({ highestStepVisited: savedHighest });

      if (data.currentStepId) {
        goToStep(data.currentStepId);
      } else if (typeof data.currentStep === 'number' && data.currentStep > 0) {
        setCurrentStep(data.currentStep);
      } else {
        setCurrentStep(0);
      }

      const { startTime } = useTaxReturnStore.getState();
      if (!startTime) {
        setStartTime(Date.now());
      }

      const params = new URLSearchParams(window.location.search);
      const toolParam = params.get('tool');
      if (toolParam) {
        useTaxReturnStore.getState().setActiveTool(toolParam);
      }
    } catch {
      toast.error('Tax return not found');
      navigate('/preparer', { replace: true });
    }
  }, [id, navigate]);

  useEffect(() => {
    window.addEventListener('beforeunload', flushAutoSave);
    return () => window.removeEventListener('beforeunload', flushAutoSave);
  }, []);

  const taxReturn = useTaxReturnStore((s) => s.taxReturn);

  if (!taxReturn) {
    return (
      <div className="min-h-screen bg-surface-900">
        <div className="bg-surface-800 border-b border-slate-700 px-6 py-3 flex items-center gap-6">
          <div className="h-8 w-32 bg-slate-700 animate-pulse rounded"></div>
          <div className="h-8 w-48 bg-slate-700 animate-pulse rounded ml-auto"></div>
        </div>
        <div className="p-6 space-y-4">
          <div className="h-12 bg-slate-700 animate-pulse rounded"></div>
          <div className="h-12 bg-slate-700 animate-pulse rounded"></div>
          <div className="h-12 bg-slate-700 animate-pulse rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-900">
      <WizardLayout>
        <StepRenderer />
      </WizardLayout>
    </div>
  );
}