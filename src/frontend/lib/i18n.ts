export type Locale = 'tr' | 'en';

export const translations = {
  tr: {
    // Header
    appName: 'CerebraLink',
    appSubtitle: 'Tıbbi Yapay Zeka Asistanı',
    newChat: 'Yeni Sohbet',
    history: 'Geçmiş',
    knowledgeGraph: 'Bilgi Grafiği',
    labTrends: 'Lab Trendleri',
    legend: 'Gösterge',

    // Legend
    legendTitle: 'Tanı Önemi',
    legendCritical: 'Kritik / Ana Tanı',
    legendImportant: 'Önemli / Aktif Sorun',
    legendModerate: 'Orta / İnceleme Altında',
    legendResolved: 'Çözülmüş / Koruyucu',
    legendInfo: 'Bilgilendirme / Takip',

    // Patient context
    patientContextActive: 'Hasta Bağlamı Aktif',

    // Patient Ingest - Step 1
    welcome: 'Hoş Geldiniz',
    welcomeSubtitle: 'Ön görüşme başlamadan önce kimlik doğrulamanız gerekiyor',
    firstName: 'Ad',
    firstNamePlaceholder: 'Kimliğinizdeki adınız',
    lastName: 'Soyad',
    lastNamePlaceholder: 'Kimliğinizdeki soyadınız',
    continue: 'Devam Et',
    nameRequired: 'Lütfen adınızı ve soyadınızı girin',

    // Patient Ingest - Step 2
    protocolEntry: 'Protokol Numarası',
    protocolSubtitle: 'Randevu belgenizde bulunan protokol numaranızı girin',
    protocolNumber: 'Protokol No',
    protocolPlaceholder: 'ör. 30256609',
    department: 'Bölüm',
    startInterview: 'Ön Görüşmeyi Başlat',
    fetchingData: 'Hasta verileri alınıyor...',
    back: 'Geri',

    // Departments
    'dept.Kardiyoloji': 'Kardiyoloji',
    'dept.Nöroloji': 'Nöroloji',
    'dept.Gastroenteroloji': 'Gastroenteroloji',
    'dept.Ortopedi': 'Ortopedi',
    'dept.Göğüs Hastalıkları': 'Göğüs Hastalıkları',
    'dept.Göz Hastalıkları': 'Göz Hastalıkları',
    'dept.Enfeksiyon Hastalıkları': 'Enfeksiyon Hastalıkları',
    'dept.Üroloji': 'Üroloji',
    'dept.Genel Cerrahi': 'Genel Cerrahi',
    'dept.Kadın Hastalıkları': 'Kadın Hastalıkları',
    'dept.Psikiyatri': 'Psikiyatri',
    'dept.Beyin-Sinir Cerrahisi': 'Beyin-Sinir Cerrahisi',
    'dept.Dermatoloji': 'Dermatoloji',
    'dept.KBB': 'KBB',
    'dept.Endokrinoloji': 'Endokrinoloji',

    // Chat
    chatPlaceholder: 'Klinik soru sorun...',
    connectionError: 'Bağlantı hatası oluştu. Lütfen tekrar deneyin.',

    // Voice
    listening: 'Dinleniyor...',
    tapToSpeak: 'Konuşmak için mikrofona dokunun',
    switchToText: 'Yazıya geç',
    switchToVoice: 'Sese geç',
    agentSpeaking: 'Asistan konuşuyor...',
    processing: 'İşleniyor...',
    start: 'Başlat',
    stop: 'Durdur',
    micDenied: 'Mikrofon erişimi reddedildi',
    liveTranscribing: 'Konuşuyorsunuz...',
    recordingTapToSend: 'Kaydediliyor… bitince mikrofona dokunun',
    agentSpeakingTapInterrupt: 'Konuşmak için mikrofona dokunun',
    stopAndSend: 'Durdur ve gönder',
    tapToInterrupt: 'Sözünü kes',
    skipDataFetch: 'Veri çekmeyi atla',
    skipDataFetchHint: 'Cerebral verisi olmadan başlat',
    transcribingHint: 'Söyledikleriniz yazıya dökülüyor…',

    // Interview Progress
    interviewProgress: 'Görüşme İlerleme',
    sections: 'bölüm',
    infoCollected: 'Toplanan Bilgi',
    questionsAnswered: 'Yanıtlanan soru',
    'section.demographics': 'Hasta Demografisi',
    'section.chief_complaint': 'Başvuru Yakınması',
    'section.hpi': 'Şimdiki Hastalık Öyküsü',
    'section.pmh': 'Özgeçmiş',
    'section.medications': 'Mevcut İlaçlar',
    'section.allergies': 'Alerjiler',
    'section.social': 'Sosyal Öykü',
    'section.ros': 'Sistem Sorgulaması',

    // Patient Summary Panel
    overview: 'Genel',
    visitHistory: 'Geçmiş',
    medications: 'İlaçlar',
    labs: 'Laboratuvar',
    clinicalTimeline: 'Klinik Zaman Çizelgesi',
    activeProblems: 'Aktif Sorunlar',
    chronicConditions: 'Kronik Hastalıklar',
    allergies: 'Alerjiler',
    noKnownAllergies: 'Bilinen alerji YOK',
    preVisitFocus: 'Ön Vizit Odak Alanları',
    currentMedications: 'Mevcut İlaçlar',
    noMedications: 'Düzenli ilaç kullanımı yok',
    recentLabs: 'Son Lab Sonuçları',
    noLabResults: 'Lab sonucu bulunmamaktadır',
    recentImaging: 'Son Görüntüleme',
    riskFactors: 'Risk Faktörleri',
    surgicalHistory: 'Cerrahi Öykü',
    izlemBrief: 'İzlem Brief',
    copy: 'Kopyala',
    copied: 'Kopyalandı!',
    graph: 'Grafik',
    priorityLabel: 'Öncelik:',
    trGuidelines: 'TR kılavuzları',

    // Summary header
    patientClinicalSummary: 'HASTA KLİNİK ÖZET ANALİZİ',
    generalProfile: 'Genel Profil',
    followUpDuration: 'Takip süresi',
    totalVisits: 'Toplam başvuru',
    departments: 'Başvurulan bölümler',
    institution: 'Kurum',
    chronologicalViz: 'KRONOLOJİK VİZUALİZASYON',
    yearDeptDiagImportance: 'YIL BÖLÜM TANI ÖNEMİ',

    // Completion
    interviewComplete: 'Görüşme Tamamlandı',
    thankYou: 'Teşekkür ederiz!',
    completeMessage: 'Ön görüşmeniz tamamlanmıştır. Lütfen doktorunuza yönlendirilmek üzere bekleyiniz.',
    continueToDoctor: 'Lütfen doktorunuza devam ediniz',
    downloadReport: 'Raporu İndir',
    viewSummary: 'Özeti Görüntüle',
    newInterview: 'Yeni Görüşme',
    reportGenerated: 'Rapor oluşturuldu',

    // Export
    exportJSON: 'JSON',
    exportMarkdown: 'Markdown',
    exportPDF: 'PDF',
  },

  en: {
    // Header
    appName: 'CerebraLink',
    appSubtitle: 'Medical AI Assistant',
    newChat: 'New Chat',
    history: 'History',
    knowledgeGraph: 'Knowledge Graph',
    labTrends: 'Lab Trends',
    legend: 'Legend',

    // Legend
    legendTitle: 'Diagnostic Importance',
    legendCritical: 'Critical / Primary Diagnosis',
    legendImportant: 'Important / Active Problem',
    legendModerate: 'Moderate / Under Investigation',
    legendResolved: 'Resolved / Preventive',
    legendInfo: 'Informational / Follow-up',

    // Patient context
    patientContextActive: 'Patient Context Active',

    // Patient Ingest - Step 1
    welcome: 'Welcome',
    welcomeSubtitle: 'Please verify your identity before the pre-visit interview begins',
    firstName: 'First Name',
    firstNamePlaceholder: 'Name as on your ID card',
    lastName: 'Last Name',
    lastNamePlaceholder: 'Surname as on your ID card',
    continue: 'Continue',
    nameRequired: 'Please enter your first and last name',

    // Patient Ingest - Step 2
    protocolEntry: 'Protocol Number',
    protocolSubtitle: 'Enter the protocol number from your appointment document',
    protocolNumber: 'Protocol No',
    protocolPlaceholder: 'e.g. 30256609',
    department: 'Department',
    startInterview: 'Start Pre-Visit Interview',
    fetchingData: 'Fetching patient data...',
    back: 'Back',

    // Departments
    'dept.Kardiyoloji': 'Cardiology',
    'dept.Nöroloji': 'Neurology',
    'dept.Gastroenteroloji': 'Gastroenterology',
    'dept.Ortopedi': 'Orthopedics',
    'dept.Göğüs Hastalıkları': 'Pulmonology',
    'dept.Göz Hastalıkları': 'Ophthalmology',
    'dept.Enfeksiyon Hastalıkları': 'Infectious Diseases',
    'dept.Üroloji': 'Urology',
    'dept.Genel Cerrahi': 'General Surgery',
    'dept.Kadın Hastalıkları': 'Obstetrics & Gynecology',
    'dept.Psikiyatri': 'Psychiatry',
    'dept.Beyin-Sinir Cerrahisi': 'Neurosurgery',
    'dept.Dermatoloji': 'Dermatology',
    'dept.KBB': 'ENT',
    'dept.Endokrinoloji': 'Endocrinology',

    // Chat
    chatPlaceholder: 'Ask a clinical question...',
    connectionError: 'Connection error. Please try again.',

    // Voice
    listening: 'Listening...',
    tapToSpeak: 'Tap the microphone to start speaking',
    switchToText: 'Switch to text',
    switchToVoice: 'Switch to voice',
    agentSpeaking: 'Assistant speaking...',
    processing: 'Processing...',
    start: 'Start',
    stop: 'Stop',
    micDenied: 'Microphone access denied',
    liveTranscribing: 'You are speaking...',
    recordingTapToSend: 'Recording… tap mic when finished',
    agentSpeakingTapInterrupt: 'Tap mic to speak',
    stopAndSend: 'Stop and send',
    tapToInterrupt: 'Interrupt',
    skipDataFetch: 'Skip data fetch',
    skipDataFetchHint: 'Start without Cerebral data',
    transcribingHint: 'Transcribing what you said…',

    // Interview Progress
    interviewProgress: 'Interview Progress',
    sections: 'sections',
    infoCollected: 'Information Collected',
    questionsAnswered: 'Questions answered',
    'section.demographics': 'Patient Demographics',
    'section.chief_complaint': 'Chief Complaint',
    'section.hpi': 'History of Present Illness',
    'section.pmh': 'Past Medical History',
    'section.medications': 'Current Medications',
    'section.allergies': 'Allergies',
    'section.social': 'Social History',
    'section.ros': 'Review of Systems',

    // Patient Summary Panel
    overview: 'Overview',
    visitHistory: 'History',
    medications: 'Meds',
    labs: 'Labs',
    clinicalTimeline: 'Clinical Timeline',
    activeProblems: 'Active Problems',
    chronicConditions: 'Chronic Conditions',
    allergies: 'Allergies',
    noKnownAllergies: 'No known allergies',
    preVisitFocus: 'Pre-Visit Focus Areas',
    currentMedications: 'Current Medications',
    noMedications: 'No regular medication use',
    recentLabs: 'Recent Lab Results',
    noLabResults: 'No recent lab results available',
    recentImaging: 'Recent Imaging',
    riskFactors: 'Risk Factors',
    surgicalHistory: 'Surgical History',
    izlemBrief: 'İzlem Brief',
    copy: 'Copy',
    copied: 'Copied!',
    graph: 'Graph',
    priorityLabel: 'Priority:',
    trGuidelines: 'TR guidelines',

    // Summary header
    patientClinicalSummary: 'PATIENT CLINICAL SUMMARY',
    generalProfile: 'General Profile',
    followUpDuration: 'Follow-up duration',
    totalVisits: 'Total visits',
    departments: 'Departments visited',
    institution: 'Institution',
    chronologicalViz: 'CHRONOLOGICAL VISUALIZATION',
    yearDeptDiagImportance: 'YEAR DEPARTMENT DIAGNOSIS IMPORTANCE',

    // Completion
    interviewComplete: 'Interview Complete',
    thankYou: 'Thank you!',
    completeMessage: 'Your pre-visit interview is complete. Please proceed to your doctor.',
    continueToDoctor: 'Please continue to your doctor',
    downloadReport: 'Download Report',
    viewSummary: 'View Summary',
    newInterview: 'New Interview',
    reportGenerated: 'Report generated',

    // Export
    exportJSON: 'JSON',
    exportMarkdown: 'Markdown',
    exportPDF: 'PDF',
  },
} as const;

export type TranslationKey = keyof typeof translations.en;

export function t(locale: Locale, key: TranslationKey): string {
  return translations[locale][key] || translations.en[key] || key;
}
