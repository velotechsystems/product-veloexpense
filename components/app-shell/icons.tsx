/**
 * `NavIcon` → lucide component. Kept out of `lib/nav/sections.ts` so that file
 * stays pure data a unit test can import without React.
 *
 * Rendered on the SERVER and passed to the client `NavLink` as children: a
 * component function cannot cross the server→client boundary as a prop.
 */
import {
  Banknote,
  Bell,
  BookOpen,
  ChartColumn,
  CircleCheck,
  CreditCard,
  House,
  Languages,
  Library,
  ListOrdered,
  Mail,
  Palette,
  PiggyBank,
  Plug,
  Puzzle,
  Receipt,
  ScrollText,
  Send,
  Settings,
  ShieldCheck,
  UserCog,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { NavIcon } from '@/lib/nav/sections';

export const NAV_ICONS: Record<NavIcon, LucideIcon> = {
  home: House,
  bell: Bell,
  receipt: Receipt,
  check: CircleCheck,
  'users-cog': UserCog,
  chart: ChartColumn,
  'piggy-bank': PiggyBank,
  banknote: Banknote,
  book: BookOpen,
  library: Library,
  scroll: ScrollText,
  shield: ShieldCheck,
  users: Users,
  ladder: ListOrdered,
  plug: Plug,
  puzzle: Puzzle,
  palette: Palette,
  languages: Languages,
  mail: Mail,
  send: Send,
  card: CreditCard,
  settings: Settings,
};
