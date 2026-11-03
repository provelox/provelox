import { redirect } from 'next/navigation';

/** These settings moved: old links and bookmarks land on their new place. */
export default function Moved() {
  redirect('/settings/deploy-keys');
}
