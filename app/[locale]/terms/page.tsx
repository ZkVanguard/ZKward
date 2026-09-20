export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#F5F5F7] py-12 px-4">
      <div className="max-w-4xl mx-auto bg-white rounded-lg shadow-sm border border-[#E5E5EA] p-8">
        <h1 className="text-4xl font-bold mb-8 text-[#1D1D1F]">Terms of Service</h1>
        
        <div className="space-y-6 text-[#424245]">
          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">1. Acceptance of Terms</h2>
            <p>
              By accessing and using ZKward, you agree to be bound by these Terms of Service. If you do not
              agree to these terms, please do not use our platform.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">2. Description of Service</h2>
            <p>
              ZKward is a multi-chain AI-managed vault platform that uses seven autonomous agents and
              zero-knowledge proofs to provide privacy-preserving financial services on Hedera
              (primary) and SUI (secondary) networks.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">3. Risk Disclosure</h2>
            <div className="bg-[#FF9500]/10 border border-[#FF9500]/30 rounded-lg p-4 my-4">
              <p className="font-semibold text-[#FF9500] mb-2">⚠️ Important Risks</p>
              <ul className="list-disc pl-6 space-y-2 text-[#424245]">
                <li>Cryptocurrency investments carry high risk and volatility</li>
                <li>You may lose part or all of your invested capital</li>
                <li>AI recommendations are not financial advice</li>
                <li>Smart contracts may contain bugs or vulnerabilities</li>
                <li>Past performance does not guarantee future results</li>
              </ul>
            </div>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">4. User Responsibilities</h2>
            <p>You are responsible for:</p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>Securing your private keys and wallet credentials</li>
              <li>Conducting your own research before making investment decisions</li>
              <li>Complying with local laws and regulations</li>
              <li>Paying all applicable gas fees and transaction costs</li>
              <li>Understanding the risks of decentralized finance (DeFi)</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">5. AI Agent Disclaimers</h2>
            <p>
              Our AI agents provide automated analysis and suggestions, but:
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>They do not constitute financial, investment, or legal advice</li>
              <li>You should consult qualified professionals for personalized advice</li>
              <li>AI predictions may be inaccurate or incomplete</li>
              <li>We do not guarantee any specific investment outcomes</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">6. Smart Contract Risks</h2>
            <p>
              ZKward operates through smart contracts on Hedera and SUI networks. While our contracts have been
              tested, users acknowledge that:
            </p>
            <ul className="list-disc pl-6 space-y-2 mt-2">
              <li>Smart contracts are experimental technology</li>
              <li>Bugs or vulnerabilities may exist despite our best efforts</li>
              <li>Blockchain transactions are irreversible</li>
              <li>We are not liable for losses due to smart contract failures</li>
            </ul>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">7. Intellectual Property</h2>
            <p>
              ZKward is open-source software licensed under Apache 2.0. You may use, modify, and distribute
              the code subject to the license terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">8. Limitation of Liability</h2>
            <p>
              To the maximum extent permitted by law, ZKward and its contributors shall not be liable for any
              indirect, incidental, special, consequential, or punitive damages, including loss of profits, data,
              or other intangible losses resulting from your use of the platform.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">9. No Warranties</h2>
            <p>
              The platform is provided "AS IS" without warranties of any kind, either express or implied,
              including but not limited to warranties of merchantability, fitness for a particular purpose, or
              non-infringement.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">10. Governing Law</h2>
            <p>
              These Terms shall be governed by and construed in accordance with applicable laws. Any disputes
              shall be resolved through binding arbitration.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">11. Changes to Terms</h2>
            <p>
              We reserve the right to modify these terms at any time. Continued use of the platform after changes
              constitutes acceptance of the updated terms.
            </p>
          </section>

          <section>
            <h2 className="text-2xl font-semibold mb-4 text-[#1D1D1F]">12. Contact Information</h2>
            <p>
              For questions about these Terms, contact:{' '}
              <a href="mailto:legal@zkvanguard.io" className="text-[#007AFF] hover:underline">
                legal@zkvanguard.io
              </a>
            </p>
          </section>

          <div className="bg-[#007AFF]/10 border border-[#007AFF]/30 rounded-lg p-4 mt-8">
            <p className="text-sm text-[#1D1D1F]">
              <strong>By connecting your wallet and using ZKward, you acknowledge that you have read,
              understood, and agree to be bound by these Terms of Service.</strong>
            </p>
          </div>

          <p className="text-sm text-[#6E6E73] mt-8 pt-8 border-t border-[#E5E5EA]">
            Last Updated: January 2, 2026
          </p>
        </div>
      </div>
    </div>
  );
}
