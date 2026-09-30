import { ReactNode } from 'react';
import { Info, AlertTriangle, Lightbulb, ExternalLink } from 'lucide-react';

interface CalloutCardProps {
  variant: 'info' | 'warning' | 'tip';
  title: string;
  children: ReactNode;
  irsUrl?: string;
}

const VARIANT_STYLES = {
  info: {
    bg: 'bg-HATaxService-blue-600/10 border-HATaxService-blue-600/30',
    title: 'text-HATaxService-blue-300',
    icon: Info,
  },
  warning: {
    bg: 'bg-amber-500/10 border-amber-500/20',
    title: 'text-amber-300',
    icon: AlertTriangle,
  },
  tip: {
    bg: 'bg-HATaxService-orange-500/10 border-HATaxService-orange-500/20',
    title: 'text-HATaxService-orange-300',
    icon: Lightbulb,
  },
} as const;

export default function CalloutCard({ variant, title, children, irsUrl }: CalloutCardProps) {
  const styles = VARIANT_STYLES[variant];
  const Icon = styles.icon;

  return (
    <div className={`rounded-lg border p-4 ${styles.bg}`}>
      <div className="flex items-start gap-2.5">
        <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${styles.title}`} />
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-medium ${styles.title}`}>{title}</div>
          <div className="text-sm text-slate-400 mt-1 leading-relaxed">{children}</div>
          {irsUrl && (
            <a
              href={irsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-2 text-xs text-HATaxService-blue-400 hover:text-HATaxService-blue-300 transition-colors"
            >
              <ExternalLink className="w-3 h-3" />
              Learn more on IRS.gov
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
