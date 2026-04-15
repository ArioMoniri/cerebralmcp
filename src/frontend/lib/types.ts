export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface PatientIdentity {
  firstName: string;
  lastName: string;
}

export interface PatientSummary {
  patient: {
    name?: string;
    age?: string;
    sex?: string;
    patient_id?: string;
    birth_date?: string;
  };
  allergies?: string[];
  chronic_conditions?: string[];
  current_medications?: Array<{
    name: string;
    dose: string;
    frequency: string;
  }>;
  visit_history?: Array<{
    date: string;
    department: string;
    facility: string;
    doctor: string;
    diagnoses: Array<{ icd_code: string; name: string }>;
    complaints: string[];
    key_findings: string;
    treatment: string;
  }>;
  active_problems?: string[];
  risk_factors?: string[];
  recent_labs?: Array<{
    test: string;
    value: string;
    date: string;
    flag: 'normal' | 'high' | 'low';
  }>;
  recent_imaging?: Array<{
    type: string;
    date: string;
    findings: string;
  }>;
  surgical_history?: string[];
  family_history?: string;
  social_history?: string;
  clinical_timeline_summary?: string;
  pre_visit_focus_areas?: string[];
}

export type AppStep = 'identity' | 'protocol' | 'interview' | 'complete';
