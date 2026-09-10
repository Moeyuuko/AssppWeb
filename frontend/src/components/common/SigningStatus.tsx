import { useTranslation } from 'react-i18next';
import { useSapStore } from '../../store/sap';

export default function SigningStatus() {
  const { t } = useTranslation();
  const { stage, percent } = useSapStore();
  if (stage !== 'assets' && stage !== 'initializing') return null;
  return (
    <p
      role="status"
      aria-live="polite"
      className="text-sm text-gray-600 dark:text-gray-400"
    >
      {t(
        stage === 'assets'
          ? 'accounts.addForm.signingAssets'
          : 'accounts.addForm.signingSetup',
        { percent },
      )}
    </p>
  );
}
