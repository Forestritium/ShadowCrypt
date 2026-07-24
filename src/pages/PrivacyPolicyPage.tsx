import { Shield, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function PrivacyPolicyPage() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background flex flex-col p-6 max-w-2xl mx-auto text-foreground">
      <button 
        onClick={() => navigate(-1)} 
        className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground hover:text-foreground mb-8 pt-4 transition-colors w-fit"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <Shield className="w-6 h-6 text-primary" />
        </div>
        <h1 className="text-2xl font-bold">Privacy Policy and Terms of Service</h1>
      </div>
      
      <div className="space-y-6 text-sm text-muted-foreground leading-relaxed">
        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">1. End-to-End Encryption</h2>
          <p>SylvaCrypt uses state-of-the-art AES-256-GCM and X25519 Elliptic Curve Cryptography. All messages, images, and files are encrypted on your device before they leave. We have absolutely no way to decrypt or read your communications.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">2. Zero-Knowledge Architecture</h2>
          <p>Your vault key is derived directly from your password. Your password is never sent to our servers. We cannot recover your account or read your contacts if you lose your password.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">3. Data Collection</h2>
          <p>We collect only the bare minimum data necessary to operate the service. We do not collect or require your real email address. Instead, we generate a dummy email based on your username. We only store the username you provide, optional profile details (like a bio or profile picture), hashed authentication credentials, encrypted message payloads, and encrypted metadata required for synchronization. We do not track your IP address, device telemetry, or personal browsing habits.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">4. Data Retention & Encryption Keys</h2>
          <p>Encrypted messages are securely stored in our cloud to sync across your devices, and deleted messages are purged permanently. We do not sell, rent, or share any metadata or usage analytics.</p>
          <p className="mt-2"><strong>Why we cannot read your messages:</strong> The cryptographic system uses two parts. <strong>Public Keys</strong> are stored in our database so that other users can fetch them to securely lock (encrypt) messages meant for you. However, your <strong>Private Decryption Keys</strong> are mathematically derived directly from your password and are strictly stored locally on your device. Since your private decryption keys never leave your device, it is mathematically impossible for us to decrypt or read your messages.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">5. Prohibited Activities</h2>
          <p>SylvaCrypt strictly prohibits the use of our platform for Spam, Botting, Marketing, and Advertising. Any activity that negatively affects the user experience is a violation of our terms and will face strict actions and consequences, including permanent account termination.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">6. Open Source</h2>
          <p>The code running this platform is publicly verifiable. Our commitment is strictly to your privacy and security.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">7. Custom Theme Background Image Usage Guidelines</h2>
          <p>Users should use images as the background of a custom theme only if it fits in the following criteria:</p>
          <ul className="list-disc list-inside mt-2 space-y-1 ml-4">
            <li>You have permissions/rights to use that image.</li>
            <li>The image is non-abusive.</li>
            <li>The image doesn't contain any explicit or adult content.</li>
            <li>The image doesn't have any personal/private data.</li>
            <li>The image doesn't depict any illegal activities.</li>
            <li>The image should not depict any violent, self-harming, aggressive, or dangerous activities.</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">8. Public Themes Standard</h2>
          <p>Any image attached to a Public Theme undergoes strict compliance with community guidelines, as it will be visible/downloadable by other users.</p>
          <p className="mt-2"><strong>Right to Remove:</strong> SylvaCrypt reserves the right to unpublish, delete, or revert any theme if it violates the community standards.</p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-foreground mb-2">9. Contact Us</h2>
          <p>If you have any questions or concerns about your privacy, or if you need to report abusive behavior, please contact the developer at <a href="mailto:admin.forestritium@gmail.com" className="text-primary hover:underline">admin.forestritium@gmail.com</a>.</p>
        </section>
      </div>
    </div>
  );
}
