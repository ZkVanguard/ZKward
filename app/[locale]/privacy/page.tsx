export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-[#F5F5F7] py-12 px-4">
      <div className="max-w-4xl mx-auto bg-white rounded-lg shadow-sm border border-[#E5E5EA] p-8">
        <h1 className="text-4xl font-bold mb-8 text-[#1D1D1F]">Privacy Policy</h1>
        
        <div className="space-y-6 text-[#424245]">
          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">1. Introduction</h2>
            <p>
              ZKward is committed to protecting your privacy. This policy explains how we handle your data
              when you use our decentralized portfolio management platform. We comply with GDPR, CCPA, and other
              applicable privacy regulations.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">2. Data We Collect</h2>
            <p className="mb-3"><strong>With Your Consent (Optional Analytics):</strong></p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Page Views:</strong> Which pages you visit (no IP addresses stored)</li>
              <li><strong>Feature Usage:</strong> Aggregated data on which features are used</li>
              <li><strong>Session Data:</strong> Anonymous session identifiers (not linked to identity)</li>
              <li><strong>Error Logs:</strong> Technical errors to help us improve the platform</li>
            </ul>
            <p className="mt-4 mb-3"><strong>Necessary for Platform Operation:</strong></p>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Wallet Address:</strong> Your public blockchain address when you connect your wallet</li>
              <li><strong>Transaction Data:</strong> On-chain transaction history for portfolio analysis</li>
            </ul>
            <p className="mt-4 text-sm text-[#6E6E73]">
              <strong>We do NOT collect:</strong> Names, emails, phone numbers, IP addresses, precise location, 
              or any personally identifiable information (PII).
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">3. Zero-Knowledge Privacy</h2>
            <p>
              ZKward uses ZK-STARK technology to ensure:
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>Your portfolio positions remain private</li>
              <li>Transaction amounts are never revealed publicly</li>
              <li>AI agent recommendations are computed without exposing your holdings</li>
              <li>All proofs are verified on-chain without revealing sensitive data</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">4. Data Storage & Retention</h2>
            <p>
              <strong>On-Chain Data:</strong> Stored permanently on the blockchain (publicly accessible by design).
            </p>
            <p className="mt-2">
              <strong>Analytics Data:</strong> Stored in our database for 90 days, then automatically deleted.
              This data is anonymized and cannot be linked to your identity.
            </p>
            <p className="mt-2">
              <strong>Preferences:</strong> Stored locally in your browser. We do not have access to this data.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">5. Cookies & Tracking</h2>
            <p>We use the following types of cookies:</p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li><strong>Necessary:</strong> Required for wallet connection and session management</li>
              <li><strong>Analytics (Optional):</strong> Help us understand how the platform is used</li>
              <li><strong>Preferences (Optional):</strong> Remember your settings like theme and layout</li>
            </ul>
            <p className="mt-2">
              You can manage your cookie preferences at any time using the cookie banner or by clearing your browser data.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">6. Third-Party Services</h2>
            <p>We integrate with:</p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li><strong>Privy:</strong> Passwordless sign-in + embedded wallet provisioning</li>
              <li><strong>WalletConnect/Reown:</strong> For secure wallet connections</li>
              <li><strong>Hedera Network:</strong> For primary vault + Hedera Consensus Service audit trail</li>
              <li><strong>SUI Network:</strong> For multi-chain functionality</li>
              <li><strong>The Graph (Studio):</strong> Sepolia subgraph indexer for cross-chain schema demonstration</li>
              <li><strong>Crypto.com AI SDK:</strong> For portfolio analysis (optional)</li>
              <li><strong>Aiven PostgreSQL:</strong> For anonymized analytics storage</li>
            </ul>
            <p className="mt-2 text-sm text-[#6E6E73]">
              Each third-party service has its own privacy policy. We only share the minimum data necessary for functionality.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">7. Your Rights (GDPR/CCPA)</h2>
            <p>You have the right to:</p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li><strong>Access:</strong> Request a copy of data we have about you</li>
              <li><strong>Rectification:</strong> Correct inaccurate data</li>
              <li><strong>Erasure:</strong> Request deletion of your data (except on-chain data)</li>
              <li><strong>Portability:</strong> Export your data in a standard format</li>
              <li><strong>Objection:</strong> Opt out of analytics at any time via cookie settings</li>
              <li><strong>Withdraw Consent:</strong> Change your cookie preferences anytime</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">8. Data Security</h2>
            <p>
              We implement industry-standard security measures including:
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>HTTPS encryption for all data in transit</li>
              <li>Database encryption at rest</li>
              <li>Regular security audits</li>
              <li>Access controls and monitoring</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">9. International Transfers</h2>
            <p>
              Our services are hosted in the United States and European Union. If you are located outside these regions,
              your data may be transferred internationally. We ensure appropriate safeguards are in place for such transfers.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">10. Contact & Data Protection Officer</h2>
            <p>
              For privacy concerns or data requests, contact us at:{' '}
              <a href="mailto:privacy@zkward.io" className="text-[#007AFF] hover:underline">
                privacy@zkward.io
              </a>
            </p>
            <p className="mt-2">
              Response time: Within 30 days for GDPR/CCPA requests.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">11. Changes to This Policy</h2>
            <p>
              We may update this policy periodically. Significant changes will be notified via the platform.
              Continued use after changes constitutes acceptance.
            </p>
          </section>

          <p className="text-sm text-[#6E6E73] mt-8 pt-8 border-t border-[#E5E5EA]">
            Last Updated: January 13, 2026
          </p>
        </div>
      </div>
    </div>
  );
}
