import { notFound } from 'next/navigation';

/** Any path no module serves answers 404 inside the shell (app/(admin)/not-found.tsx). */
export default function MissingPage() {
  notFound();
}
