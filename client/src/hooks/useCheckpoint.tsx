import { useCallback } from 'react';
import { useTaxReturnStore } from '../store/taxReturnStore';

/**
 * Hook for auto-checkpoint on field blur.
 * Call this in form field components to automatically create a checkpoint
 * when the user leaves a field (onBlur).
 */
export function useCheckpoint(label?: string) {
  const createCheckpoint = useTaxReturnStore((s) => s.createCheckpoint);

  const onBlur = useCallback(
    (event?: React.FocusEvent) => {
      // Create checkpoint on field blur
      createCheckpoint(label || 'Field change');
    },
    [createCheckpoint, label],
  );

  return { onBlur };
}



/**
 * Custom input that checkpoints on blur
 */
export function CheckpointInput({
  label,
  onBlur,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label?: string }) {
  const { onBlur: checkpointBlur } = useCheckpoint(label);
  return (
    <input
      {...props}
      onBlur={(e: React.FocusEvent<HTMLInputElement>) => {
        checkpointBlur(e);
        onBlur?.(e);
      }}
    />
  );
}

/**
 * Custom select that checkpoints on blur
 */
export function CheckpointSelect({
  label,
  onBlur,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  const { onBlur: checkpointBlur } = useCheckpoint(label);
  return (
    <select
      {...props}
      onBlur={(e: React.FocusEvent<HTMLSelectElement>) => {
        checkpointBlur(e);
        onBlur?.(e);
      }}
    />
  );
}

/**
 * Custom textarea that checkpoints on blur
 */
export function CheckpointTextarea({
  label,
  onBlur,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string }) {
  const { onBlur: checkpointBlur } = useCheckpoint(label);
  return (
    <textarea
      {...props}
      onBlur={(e: React.FocusEvent<HTMLTextAreaElement>) => {
        checkpointBlur(e);
        onBlur?.(e);
      }}
    />
  );
}

/**
 * Hook to trigger checkpoint manually (e.g., on step change, save button, etc.)
 */
export function useCheckpointActions() {
  const createCheckpoint = useTaxReturnStore((s) => s.createCheckpoint);
  const restoreCheckpoint = useTaxReturnStore((s) => s.restoreCheckpoint);
  const deleteCheckpoint = useTaxReturnStore((s) => s.deleteCheckpoint);
  const clearCheckpoints = useTaxReturnStore((s) => s.clearCheckpoints);
  const getCheckpoints = useTaxReturnStore((s) => s.getCheckpoints);
  const checkpoints = useTaxReturnStore((s) => s.checkpoints);

  return {
    checkpoints,
    createCheckpoint,
    restoreCheckpoint,
    deleteCheckpoint,
    clearCheckpoints,
    getCheckpoints,
  };
}