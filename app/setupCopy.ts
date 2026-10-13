/**
 * The setup checklist's sentences and links (`app/page.tsx`). Its own module so
 * `app/setupCopy.test.ts` can check every link against the route tree: two of them
 * opened the wrong screen once (categories went to the spend rules, structure to the
 * employee list — Wave 1, w1-11), and a wrong destination is a page that still loads,
 * so nothing else would notice.
 */
import type { SetupItem } from '@/lib/onboarding/setup';

export const SETUP_COPY: Record<SetupItem, { title: string; why: string; href: string; cta: string }> = {
  APPROVER: {
    title: 'Invite somebody who can approve',
    // The wall a solo founder hits, said before they hit it. Nothing can be
    // submitted in a tenant of one: the submitter would be the only eligible
    // approver, and self-approval is off by default and stays off.
    why: 'Nothing can be submitted while you are the only person here — an expense report cannot be approved by the person who filed it.',
    href: '/admin/employees/invite',
    cta: 'Invite someone',
  },
  CATEGORIES: {
    title: 'Check your expense categories',
    why: 'Six were created with your organization so you can record an expense straight away. They are yours — rename them, add to them, switch off the ones you do not use.',
    // The categories screen (ported in Wave 0). It pointed at the spend-rules page,
    // which edits rules, not categories.
    href: '/admin/expense-categories',
    cta: 'Review categories',
  },
  // w4-00c: the approval workflow, which every tenant starts with (d54/d56/d59). Done while
  // one is published for expense reports; with none, nothing can be submitted (d58).
  APPROVAL_FLOW: {
    title: 'Check who approves',
    why: 'Reports go to the submitter’s manager, or to an administrator when they have none. Change the flow if large amounts or some departments need somebody else — with no published flow, nothing can be submitted.',
    href: '/admin/approval-workflows',
    cta: 'Review approvals',
  },
  SPEND_POLICY: {
    title: 'Set your spend rules',
    why: 'Limits and receipt requirements are checked when a report is submitted. With no rules, nothing is ever flagged.',
    // w4-02d: the Rule Builder, since the cutover (/admin/expense-policies is gone).
    href: '/admin/policy-rules',
    cta: 'Add a rule',
  },
  STRUCTURE: {
    title: 'Describe your organization',
    why: 'Legal entities, business units and departments are how spending is grouped, reported on and consolidated.',
    // Legal entities first, as the sentence lists them; business units and departments
    // are beside it in the menu (all ported in Wave 1). It pointed at the employee list,
    // which has none of the three.
    href: '/admin/legal-entities',
    cta: 'Add structure',
  },
  BRANDING: {
    title: 'Make it look like yours',
    why: 'Your name and colour appear on the screens your people use and on the emails they receive.',
    href: '/admin/branding',
    cta: 'Add branding',
  },
};
