import { Loading } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { AdminHome } from '@/screens/AdminHome';
import { DriverHome } from '@/screens/DriverHome';
import { ParentHome } from '@/screens/ParentHome';
import { RiderHome } from '@/screens/RiderHome';

/**
 * One route, four homes. The tab is called different things per role (see the
 * layout) but it is always "the thing you opened the app to do".
 */
export default function Home() {
  const { profile, loading } = useAuth();

  if (loading || !profile) return <Loading />;

  switch (profile.role) {
    case 'driver':
      return <DriverHome />;
    case 'parent':
      return <ParentHome />;
    case 'admin':
      return <AdminHome />;
    case 'student':
    case 'faculty':
      return <RiderHome />;
  }
}
