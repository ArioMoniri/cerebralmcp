'use client';

interface InterviewProgressProps {
  chatHistory: Array<{ role: string; content: string; timestamp: string }>;
  isComplete: boolean;
}

const SECTIONS = [
  { key: 'demographics', label: 'Patient Demographics', keywords: ['yaş', 'isim', 'ad', 'cinsiyet', 'name', 'age'] },
  { key: 'chief_complaint', label: 'Chief Complaint', keywords: ['yakınma', 'şikayet', 'neden', 'complaint', 'bugün'] },
  { key: 'hpi', label: 'History of Present Illness', keywords: ['ne zaman', 'başladı', 'nasıl', 'süre', 'şiddet', 'ağrı'] },
  { key: 'pmh', label: 'Past Medical History', keywords: ['kronik', 'hastalık', 'ameliyat', 'geçmiş', 'öykü'] },
  { key: 'medications', label: 'Current Medications', keywords: ['ilaç', 'tedavi', 'kullan', 'doz', 'medication'] },
  { key: 'allergies', label: 'Allergies', keywords: ['alerji', 'allergy', 'reaksiyon'] },
  { key: 'social', label: 'Social History', keywords: ['sigara', 'alkol', 'meslek', 'smoking', 'alcohol'] },
  { key: 'ros', label: 'Review of Systems', keywords: ['sistem', 'sorgulama', 'nefes', 'ödem', 'baş ağrısı'] },
];

function detectCompletedSections(messages: Array<{ role: string; content: string }>): Set<string> {
  const completed = new Set<string>();
  const allText = messages.map(m => m.content.toLowerCase()).join(' ');

  for (const section of SECTIONS) {
    const matchCount = section.keywords.filter(kw => allText.includes(kw)).length;
    if (matchCount >= 2) {
      completed.add(section.key);
    }
  }

  return completed;
}

export default function InterviewProgress({ chatHistory, isComplete }: InterviewProgressProps) {
  const completed = detectCompletedSections(chatHistory);
  const userMessages = chatHistory.filter(m => m.role === 'user').length;
  const sectionsCompleted = completed.size;

  return (
    <div className="p-4 border-b border-cerebral-border">
      <div className="glass-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-cerebral-text">Interview Progress</h3>
          <span className="text-xs text-cerebral-muted">{sectionsCompleted}/{SECTIONS.length} sections</span>
        </div>

        {/* Progress Bar */}
        <div className="w-full h-1.5 bg-cerebral-bg rounded-full mb-4 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-cerebral-accent to-cerebral-teal rounded-full transition-all duration-500"
            style={{ width: `${isComplete ? 100 : (sectionsCompleted / SECTIONS.length) * 100}%` }}
          />
        </div>

        {/* Section Checklist */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-cerebral-muted uppercase tracking-wider">Information Collected</h4>
          {SECTIONS.map(section => (
            <div key={section.key} className="flex items-center gap-2.5">
              <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0
                ${completed.has(section.key)
                  ? 'border-cerebral-green bg-cerebral-green/20'
                  : 'border-cerebral-border'
                }`}
              >
                {completed.has(section.key) && (
                  <svg className="w-2.5 h-2.5 text-cerebral-green" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                )}
              </div>
              <span className={`text-sm ${completed.has(section.key) ? 'text-cerebral-text' : 'text-cerebral-muted'}`}>
                {section.label}
              </span>
            </div>
          ))}
        </div>

        {/* Answers Counter */}
        <div className="mt-4 pt-3 border-t border-cerebral-border/50 flex items-center justify-between">
          <span className="text-xs text-cerebral-muted">Questions answered</span>
          <span className="text-sm font-mono font-semibold text-cerebral-text">{userMessages}</span>
        </div>
      </div>
    </div>
  );
}
