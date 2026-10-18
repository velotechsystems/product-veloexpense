import { describe, expect, it } from 'vitest';
import { titleToJobLevelCode as lvl } from './jobLevels';

describe('titleToJobLevelCode', () => {
  it('places the C-suite and board above everything else', () => {
    expect(lvl('Chief Financial Officer')).toBe('E4');
    expect(lvl('CFO')).toBe('E4');
    expect(lvl('President & CEO')).toBe('E4');
    expect(lvl('Board Member')).toBe('Board');
  });

  it('separates the executive rungs', () => {
    expect(lvl('Senior Vice President, Operations')).toBe('E3');
    expect(lvl('SVP Finance')).toBe('E3');
    expect(lvl('Vice President, Product')).toBe('E2');
    expect(lvl('VP Engineering')).toBe('E2');
    expect(lvl('Head of Data')).toBe('E1');
  });

  it('separates the manager rungs, including abbreviations', () => {
    expect(lvl('Senior Director, Product and Engineering')).toBe('M6');
    expect(lvl('Director, Client Services')).toBe('M5');
    expect(lvl('Sr. Manager Financial Reporting & Compliance')).toBe('M4');
    expect(lvl('SR Manager, Payroll')).toBe('M4');
    expect(lvl('Manager, Analytics')).toBe('M3');
    expect(lvl('Manager, Inside Sales')).toBe('M3');
    expect(lvl('Shop Supervisor')).toBe('M2');
  });

  it('does NOT treat sales/marketing IC "manager" titles as people managers', () => {
    // The whole point of the override list: these manage a book of business,
    // not people, and levelling them M3 would splice them into the approval
    // ladder above their actual peers.
    expect(lvl('Account Manager')).toBe('IC4');
    expect(lvl('Senior Account  Manager')).toBe('IC5');
    expect(lvl('Territory Sales Manager')).toBe('IC5');
    expect(lvl('Account Performance Manager')).toBe('IC4');
    expect(lvl('Marketing Campaign Manager')).toBe('IC4');
    expect(lvl('Product Manager')).toBe('IC5');
  });

  it('ranks the IC ladder by seniority marker', () => {
    expect(lvl('Distinguished Developer')).toBe('IC9');
    expect(lvl('Principal Developer, Mobile Technology')).toBe('IC8');
    expect(lvl('Staff Developer')).toBe('IC7');
    expect(lvl('Training/Inside Sales Lead')).toBe('IC6');
    expect(lvl('SR Frontend Developer')).toBe('IC5');
    expect(lvl('Senior SEO & Content Strategist')).toBe('IC5');
    expect(lvl('Junior Graphic Designer')).toBe('IC1');
  });

  it('gives untitled professional and frontline roles a floor', () => {
    expect(lvl('Technical Support Analyst')).toBe('IC4');
    expect(lvl('SEO & Content Strategist')).toBe('IC4');
    expect(lvl('People & Culture Business Partner')).toBe('IC4');
    expect(lvl('Logistics Center Coordinator')).toBe('IC2');
    expect(lvl('Block Clerk')).toBe('IC2');
    expect(lvl('Inspector')).toBe('IC2');
    expect(lvl('Chase Driver')).toBe('IC2');
    expect(lvl('Mechanic')).toBe('IC2');
  });

  it('handles the long tail from the Jul 28 Workspace export', () => {
    // Real titles that no rule caught on the first pass. Frontline operations
    // stay IC2 so a tiered approval walks straight past them — a security guard
    // with four direct reports must not become a $10,000 approver.
    expect(lvl('Security Guard')).toBe('IC2');
    expect(lvl('Transport Dispatcher')).toBe('IC2');
    expect(lvl('Auction Ringperson')).toBe('IC2');
    expect(lvl('Vehicle Registration')).toBe('IC2');
    expect(lvl('Fleet Lease Administration')).toBe('IC2');
    expect(lvl('Fleet/Lease Admin')).toBe('IC2');
    expect(lvl('CRM Admin')).toBe('IC2');
    expect(lvl('Maintenance')).toBe('IC2');
    // Professional / credentialed.
    expect(lvl('Digital Advertising Technologist')).toBe('IC4');
    expect(lvl('Internal Translator')).toBe('IC4');
    expect(lvl('Paralegal')).toBe('IC3');
    expect(lvl('Legal Counsel')).toBe('IC6');
    expect(lvl('Product Owner')).toBe('IC5');
    // Controller is the finance director-equivalent and never says "Director".
    expect(lvl('Corporate Controller')).toBe('M5');
  });

  it('returns null rather than guessing on an unrecognized or empty title', () => {
    // Null is a signal to report, never a reason to substitute a default —
    // over-levelling hands someone approval authority they should not have.
    expect(lvl(null)).toBeNull();
    expect(lvl('')).toBeNull();
    expect(lvl('   ')).toBeNull();
    expect(lvl('Redemptions')).toBeNull();
    // Real residue from the export: no role noun to key on, and a free-text
    // note somebody typed into the title field.
    expect(lvl('National Dealer Development')).toBeNull();
    expect(lvl('Mohamud is temporary support from a staffing agency')).toBeNull();
  });
});
