import { SettingsHeader } from '@/components/settings-header';
import { ThemePicker } from '@/components/theme-picker';

export default function AppearancePage() {
  return (
    <>
      <SettingsHeader
        title="Appearance"
        description="How the console looks in this browser."
      />
      <ThemePicker />
    </>
  );
}
