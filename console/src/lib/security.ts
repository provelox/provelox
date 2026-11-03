/** What GET /v1/system/security answers: one scan of this machine and its apps. */
export interface SecurityFinding {
  id: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  fix?: string;
}

export interface SecurityScan {
  /** ISO time of the scan; null when none has run yet */
  at: string | null;
  findings: SecurityFinding[];
  /** Whether the machine itself could be looked at, not only the apps */
  hostChecked: boolean;
  hostError?: string;
}

export const SEVERITIES = ['critical', 'warning', 'info'] as const;

export const SEVERITY_TITLE: Record<SecurityFinding['severity'], string> = {
  critical: 'Needs action now',
  warning: 'Worth fixing',
  info: 'For your information',
};

/** The findings of each severity, worst first, leaving out the empty ones. */
export function groupFindings(findings: SecurityFinding[]) {
  return SEVERITIES.map((severity) => ({
    severity,
    findings: findings.filter((f) => f.severity === severity),
  })).filter((g) => g.findings.length > 0);
}

/** The headline for a scan: what a person should take from it before reading the list. */
export function verdict(scan: SecurityScan): {
  tone: 'none' | 'good' | 'warn' | 'bad';
  text: string;
} {
  if (!scan.at)
    return {
      tone: 'none',
      text: 'No check has run yet. Check now to run one.',
    };
  const critical = scan.findings.filter(
    (f) => f.severity === 'critical',
  ).length;
  const warning = scan.findings.filter((f) => f.severity === 'warning').length;
  if (critical > 0)
    return {
      tone: 'bad',
      text: `${critical} ${critical === 1 ? 'thing needs' : 'things need'} action now. If the findings below point at the machine itself, treat it as compromised.`,
    };
  if (warning > 0)
    return {
      tone: 'warn',
      text: `${warning} ${warning === 1 ? 'thing is' : 'things are'} worth fixing. Nothing points to a break-in.`,
    };
  return {
    tone: 'good',
    text: scan.hostChecked
      ? 'Nothing suspicious found. This is not proof the machine is clean: it looks for common signs.'
      : 'Nothing suspicious found in the apps, but the machine itself could not be checked.',
  };
}

/** Whether the Apps page should say something: any critical finding. */
export const hasCritical = (scan: SecurityScan | null) =>
  !!scan?.findings.some((f) => f.severity === 'critical');
