import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

// Locale-aware Link / useRouter / usePathname (paths WITHOUT the /ar or /en prefix).
export const { Link, redirect, usePathname, useRouter } = createNavigation(routing);
