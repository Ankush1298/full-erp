/**
 * Annual Holiday Catalogue for Indian Schools (Bihar initially, extensible to other states).
 *
 * Source Policy:
 * 1. National Gazetted Holidays: Ministry of Personnel, Public Grievances and Pensions (DoPT),
 *    Government of India Annual Holiday Circulars.
 * 2. Bihar State Holidays: Government of Bihar, General Administration Department (GAD) Annual
 *    Holiday Notifications, and Bihar Secondary/Primary Education Board School Holiday Schedules.
 * 3. Verification Standards:
 *    - VERIFIED: Fixed national/state gazetted days and published calendar years (2025-2027).
 *    - PROVISIONAL: Festival dates contingent on astronomical lunar sightings (e.g. Eid-ul-Fitr, Eid-ul-Adha, Muharram).
 *    - UNVERIFIED: Institution-specific closure recommendations or dates beyond confirmed gazette releases.
 */

export type HolidayKind = 'HOLIDAY' | 'NON_TEACHING_DAY' | 'EVENT';

export type HolidayCategory = 'NATIONAL' | 'STATE' | 'FESTIVAL' | 'RESTRICTED' | 'INSTITUTIONAL';

export type VerificationStatus = 'VERIFIED' | 'PROVISIONAL' | 'UNVERIFIED';

export interface HolidayCatalogueEntry {
  id: string;
  holidayDate: string; // YYYY-MM-DD
  name: string;
  kind: HolidayKind;
  category: HolidayCategory;
  jurisdiction: string;
  year: number;
  source: string;
  verificationStatus: VerificationStatus;
  verifiedDate: string | null;
  isGovernmentMandated: boolean;
  notes?: string | undefined;
  alreadyDeclared?: boolean | undefined;
}

interface RawHolidaySeed {
  key: string;
  name: string;
  kind: HolidayKind;
  category: HolidayCategory;
  jurisdiction: string;
  isGovernmentMandated: boolean;
  source: string;
  dates: Record<
    number,
    { date: string; status: VerificationStatus; verifiedDate: string | null; notes?: string }
  >;
}

const STATUTORY_NATIONAL = 'Section 25, Negotiable Instruments Act, 1881 / Gazette of India';
const DOPT_STATUTORY = 'Ministry of Personnel (DoPT) / Section 25, Negotiable Instruments Act, 1881';
const BIHAR_GAD_STATUTORY = 'Government of Bihar GAD Notification No. 11/N-1-03/2010-GAD';
const DOPT_PROVISIONAL = 'Government of India (DoPT) Gazetted List (Pending Year-Specific Circular)';
const BIHAR_GAD_PROVISIONAL = 'Government of Bihar, General Administration Department (Pending Year-Specific Circular)';
const BIHAR_EDU_PROVISIONAL = 'Bihar School Holiday Calendar, Department of Education (Pending Year-Specific Circular)';
const RECOMMENDED_INSTITUTIONAL = 'Recommended Academic Break (Requires Institution Confirmation)';

const CATALOGUE_SEEDS: RawHolidaySeed[] = [
  // --- National Gazetted Holidays (Central Government / Nationwide) ---
  {
    key: 'REPUBLIC_DAY',
    name: 'Republic Day',
    kind: 'HOLIDAY',
    category: 'NATIONAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: STATUTORY_NATIONAL,
    dates: {
      2025: { date: '2025-01-26', status: 'VERIFIED', verifiedDate: '1950-01-26', notes: 'National Holiday' },
      2026: { date: '2026-01-26', status: 'VERIFIED', verifiedDate: '1950-01-26', notes: 'National Holiday' },
      2027: { date: '2027-01-26', status: 'VERIFIED', verifiedDate: '1950-01-26', notes: 'National Holiday' },
    },
  },
  {
    key: 'INDEPENDENCE_DAY',
    name: 'Independence Day',
    kind: 'HOLIDAY',
    category: 'NATIONAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: STATUTORY_NATIONAL,
    dates: {
      2025: { date: '2025-08-15', status: 'VERIFIED', verifiedDate: '1947-08-15', notes: 'National Holiday' },
      2026: { date: '2026-08-15', status: 'VERIFIED', verifiedDate: '1947-08-15', notes: 'National Holiday' },
      2027: { date: '2027-08-15', status: 'VERIFIED', verifiedDate: '1947-08-15', notes: 'National Holiday' },
    },
  },
  {
    key: 'GANDHI_JAYANTI',
    name: 'Mahatma Gandhi Jayanti',
    kind: 'HOLIDAY',
    category: 'NATIONAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: STATUTORY_NATIONAL,
    dates: {
      2025: { date: '2025-10-02', status: 'VERIFIED', verifiedDate: '1948-10-02', notes: 'National Holiday' },
      2026: { date: '2026-10-02', status: 'VERIFIED', verifiedDate: '1948-10-02', notes: 'National Holiday' },
      2027: { date: '2027-10-02', status: 'VERIFIED', verifiedDate: '1948-10-02', notes: 'National Holiday' },
    },
  },
  {
    key: 'AMBEDKAR_JAYANTI',
    name: 'Dr. B.R. Ambedkar Jayanti',
    kind: 'HOLIDAY',
    category: 'NATIONAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: DOPT_STATUTORY,
    dates: {
      2025: { date: '2025-04-14', status: 'VERIFIED', verifiedDate: '2020-04-14', notes: 'Annual Gazetted Holiday' },
      2026: { date: '2026-04-14', status: 'VERIFIED', verifiedDate: '2020-04-14', notes: 'Annual Gazetted Holiday' },
      2027: { date: '2027-04-14', status: 'VERIFIED', verifiedDate: '2020-04-14', notes: 'Annual Gazetted Holiday' },
    },
  },
  {
    key: 'MAHAVIR_JAYANTI',
    name: 'Mahavir Jayanti',
    kind: 'HOLIDAY',
    category: 'NATIONAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: DOPT_PROVISIONAL,
    dates: {
      2025: { date: '2025-04-10', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
      2026: { date: '2026-03-31', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
      2027: { date: '2027-04-19', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
    },
  },
  {
    key: 'GOOD_FRIDAY',
    name: 'Good Friday',
    kind: 'HOLIDAY',
    category: 'NATIONAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: DOPT_PROVISIONAL,
    dates: {
      2025: { date: '2025-04-18', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable Christian holiday; subject to official year-specific gazette notification' },
      2026: { date: '2026-04-03', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable Christian holiday; subject to official year-specific gazette notification' },
      2027: { date: '2027-03-26', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable Christian holiday; subject to official year-specific gazette notification' },
    },
  },
  {
    key: 'BUDDHA_PURNIMA',
    name: 'Buddha Purnima',
    kind: 'HOLIDAY',
    category: 'NATIONAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: DOPT_PROVISIONAL,
    dates: {
      2025: { date: '2025-05-12', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
      2026: { date: '2026-05-31', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
      2027: { date: '2027-05-20', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
    },
  },
  {
    key: 'CHRISTMAS_DAY',
    name: 'Christmas Day',
    kind: 'HOLIDAY',
    category: 'NATIONAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: STATUTORY_NATIONAL,
    dates: {
      2025: { date: '2025-12-25', status: 'VERIFIED', verifiedDate: '1881-12-25', notes: 'Fixed statutory holiday' },
      2026: { date: '2026-12-25', status: 'VERIFIED', verifiedDate: '1881-12-25', notes: 'Fixed statutory holiday' },
      2027: { date: '2027-12-25', status: 'VERIFIED', verifiedDate: '1881-12-25', notes: 'Fixed statutory holiday' },
    },
  },
  {
    key: 'GURU_NANAK_JAYANTI',
    name: 'Guru Nanak Jayanti',
    kind: 'HOLIDAY',
    category: 'NATIONAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: DOPT_PROVISIONAL,
    dates: {
      2025: { date: '2025-11-05', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
      2026: { date: '2026-11-24', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
      2027: { date: '2027-11-14', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
    },
  },

  // --- Pan-India Islamic Festivals (Subject to Moon Sighting) ---
  {
    key: 'EID_UL_FITR',
    name: 'Eid-ul-Fitr',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: DOPT_PROVISIONAL,
    dates: {
      2025: {
        date: '2025-03-31',
        status: 'PROVISIONAL',
        verifiedDate: null,
        notes: 'Subject to moon sighting',
      },
      2026: {
        date: '2026-03-21',
        status: 'PROVISIONAL',
        verifiedDate: null,
        notes: 'Subject to moon sighting',
      },
      2027: {
        date: '2027-03-10',
        status: 'PROVISIONAL',
        verifiedDate: null,
        notes: 'Subject to moon sighting',
      },
    },
  },
  {
    key: 'EID_UL_ADHA',
    name: 'Eid-ul-Adha (Bakrid)',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: DOPT_PROVISIONAL,
    dates: {
      2025: {
        date: '2025-06-07',
        status: 'PROVISIONAL',
        verifiedDate: null,
        notes: 'Subject to moon sighting',
      },
      2026: {
        date: '2026-05-27',
        status: 'PROVISIONAL',
        verifiedDate: null,
        notes: 'Subject to moon sighting',
      },
      2027: {
        date: '2027-05-16',
        status: 'PROVISIONAL',
        verifiedDate: null,
        notes: 'Subject to moon sighting',
      },
    },
  },
  {
    key: 'MUHARRAM',
    name: 'Muharram',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: DOPT_PROVISIONAL,
    dates: {
      2025: {
        date: '2025-07-06',
        status: 'PROVISIONAL',
        verifiedDate: null,
        notes: 'Subject to moon sighting',
      },
      2026: {
        date: '2026-06-26',
        status: 'PROVISIONAL',
        verifiedDate: null,
        notes: 'Subject to moon sighting',
      },
      2027: {
        date: '2027-06-15',
        status: 'PROVISIONAL',
        verifiedDate: null,
        notes: 'Subject to moon sighting',
      },
    },
  },
  {
    key: 'MILAD_UN_NABI',
    name: 'Milad-un-Nabi (Id-e-Milad)',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: DOPT_PROVISIONAL,
    dates: {
      2025: {
        date: '2025-09-05',
        status: 'PROVISIONAL',
        verifiedDate: null,
        notes: 'Subject to moon sighting',
      },
      2026: {
        date: '2026-08-26',
        status: 'PROVISIONAL',
        verifiedDate: null,
        notes: 'Subject to moon sighting',
      },
      2027: {
        date: '2027-08-15',
        status: 'PROVISIONAL',
        verifiedDate: null,
        notes: 'Subject to moon sighting',
      },
    },
  },

  // --- Major Indian Festivals (National / Gazetted) ---
  {
    key: 'DUSSEHRA',
    name: 'Dussehra (Vijaya Dashami)',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: DOPT_PROVISIONAL,
    dates: {
      2025: { date: '2025-10-02', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
      2026: { date: '2026-10-20', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
      2027: { date: '2027-10-10', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
    },
  },
  {
    key: 'DIWALI',
    name: 'Diwali (Deepavali)',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'India',
    isGovernmentMandated: true,
    source: DOPT_PROVISIONAL,
    dates: {
      2025: { date: '2025-10-20', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
      2026: { date: '2026-11-08', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
      2027: { date: '2027-10-29', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to official year-specific gazette notification' },
    },
  },

  // --- Bihar State Holidays & School Calendar ---
  {
    key: 'BIHAR_DIWAS',
    name: 'Bihar Diwas (Bihar Day)',
    kind: 'HOLIDAY',
    category: 'STATE',
    jurisdiction: 'Bihar',
    isGovernmentMandated: true,
    source: BIHAR_GAD_STATUTORY,
    dates: {
      2025: { date: '2025-03-22', status: 'VERIFIED', verifiedDate: '2010-03-22', notes: 'Bihar State Foundation Day' },
      2026: { date: '2026-03-22', status: 'VERIFIED', verifiedDate: '2010-03-22', notes: 'Bihar State Foundation Day' },
      2027: { date: '2027-03-22', status: 'VERIFIED', verifiedDate: '2010-03-22', notes: 'Bihar State Foundation Day' },
    },
  },
  {
    key: 'PRAKASH_PARV',
    name: 'Guru Gobind Singh Jayanti (Prakash Parv)',
    kind: 'HOLIDAY',
    category: 'STATE',
    jurisdiction: 'Bihar',
    isGovernmentMandated: true,
    source: BIHAR_GAD_PROVISIONAL,
    dates: {
      2025: { date: '2025-01-06', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
      2026: { date: '2026-01-16', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
      2027: { date: '2027-01-14', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
    },
  },
  {
    key: 'MAHA_SHIVRATRI',
    name: 'Maha Shivratri',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'Bihar',
    isGovernmentMandated: true,
    source: BIHAR_GAD_PROVISIONAL,
    dates: {
      2025: { date: '2025-02-26', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
      2026: { date: '2026-02-15', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
      2027: { date: '2027-03-06', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
    },
  },
  {
    key: 'HOLI_DAY_1',
    name: 'Holi (Holika Dahan)',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'Bihar',
    isGovernmentMandated: true,
    source: BIHAR_EDU_PROVISIONAL,
    dates: {
      2025: { date: '2025-03-14', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2026: { date: '2026-03-03', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2027: { date: '2027-03-22', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
    },
  },
  {
    key: 'HOLI_DAY_2',
    name: 'Holi (Dhulandi)',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'Bihar',
    isGovernmentMandated: true,
    source: BIHAR_EDU_PROVISIONAL,
    dates: {
      2025: { date: '2025-03-15', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2026: { date: '2026-03-04', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2027: { date: '2027-03-23', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
    },
  },
  {
    key: 'RAM_NAVAMI',
    name: 'Ram Navami',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'Bihar',
    isGovernmentMandated: true,
    source: BIHAR_GAD_PROVISIONAL,
    dates: {
      2025: { date: '2025-04-06', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
      2026: { date: '2026-03-27', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
      2027: { date: '2027-04-15', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
    },
  },
  {
    key: 'JANMASHTAMI',
    name: 'Janmashtami',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'Bihar',
    isGovernmentMandated: true,
    source: BIHAR_EDU_PROVISIONAL,
    dates: {
      2025: { date: '2025-08-16', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2026: { date: '2026-09-03', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2027: { date: '2027-08-25', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
    },
  },
  {
    key: 'RAKSHA_BANDHAN',
    name: 'Raksha Bandhan',
    kind: 'HOLIDAY',
    category: 'RESTRICTED',
    jurisdiction: 'Bihar',
    isGovernmentMandated: false,
    source: BIHAR_EDU_PROVISIONAL,
    dates: {
      2025: { date: '2025-08-09', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2026: { date: '2026-08-28', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2027: { date: '2027-08-17', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
    },
  },
  {
    key: 'DURGA_PUJA_SAPTAMI',
    name: 'Durga Puja (Maha Saptami)',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'Bihar',
    isGovernmentMandated: true,
    source: BIHAR_EDU_PROVISIONAL,
    dates: {
      2025: { date: '2025-09-30', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2026: { date: '2026-10-18', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2027: { date: '2027-10-08', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
    },
  },
  {
    key: 'DURGA_PUJA_ASHTAMI_NAVAMI',
    name: 'Durga Puja (Maha Ashtami / Navami)',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'Bihar',
    isGovernmentMandated: true,
    source: BIHAR_EDU_PROVISIONAL,
    dates: {
      2025: { date: '2025-10-01', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2026: { date: '2026-10-19', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2027: { date: '2027-10-09', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
    },
  },
  {
    key: 'GOVARDHAN_PUJA',
    name: 'Govardhan Puja',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'Bihar',
    isGovernmentMandated: true,
    source: BIHAR_GAD_PROVISIONAL,
    dates: {
      2025: { date: '2025-10-22', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
      2026: { date: '2026-11-09', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
      2027: { date: '2027-10-30', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
    },
  },
  {
    key: 'BHAI_DOOJ',
    name: 'Bhai Dooj / Chitragupta Puja',
    kind: 'HOLIDAY',
    category: 'FESTIVAL',
    jurisdiction: 'Bihar',
    isGovernmentMandated: true,
    source: BIHAR_GAD_PROVISIONAL,
    dates: {
      2025: { date: '2025-10-23', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
      2026: { date: '2026-11-10', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
      2027: { date: '2027-10-31', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar GAD year-specific notification' },
    },
  },
  {
    key: 'CHHATH_PUJA_KHARNA',
    name: 'Chhath Puja (Kharna)',
    kind: 'HOLIDAY',
    category: 'STATE',
    jurisdiction: 'Bihar',
    isGovernmentMandated: true,
    source: BIHAR_EDU_PROVISIONAL,
    dates: {
      2025: { date: '2025-10-26', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2026: { date: '2026-11-13', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2027: { date: '2027-11-03', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
    },
  },
  {
    key: 'CHHATH_PUJA_SANDHYA_ARGHYA',
    name: 'Chhath Puja (Evening Arghya)',
    kind: 'HOLIDAY',
    category: 'STATE',
    jurisdiction: 'Bihar',
    isGovernmentMandated: true,
    source: BIHAR_EDU_PROVISIONAL,
    dates: {
      2025: { date: '2025-10-27', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2026: { date: '2026-11-14', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2027: { date: '2027-11-04', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
    },
  },
  {
    key: 'CHHATH_PUJA_PRATAH_ARGHYA',
    name: 'Chhath Puja (Morning Arghya)',
    kind: 'HOLIDAY',
    category: 'STATE',
    jurisdiction: 'Bihar',
    isGovernmentMandated: true,
    source: BIHAR_EDU_PROVISIONAL,
    dates: {
      2025: { date: '2025-10-28', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2026: { date: '2026-11-15', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
      2027: { date: '2027-11-05', status: 'PROVISIONAL', verifiedDate: null, notes: 'Movable festival date; subject to Bihar School Holiday Calendar notification' },
    },
  },
  {
    key: 'CHEHALLUM',
    name: 'Chehallum',
    kind: 'HOLIDAY',
    category: 'RESTRICTED',
    jurisdiction: 'Bihar',
    isGovernmentMandated: false,
    source: BIHAR_GAD_PROVISIONAL,
    dates: {
      2025: {
        date: '2025-08-15',
        status: 'PROVISIONAL',
        verifiedDate: '2024-11-01',
        notes: 'Subject to moon sighting',
      },
      2026: {
        date: '2026-08-04',
        status: 'PROVISIONAL',
        verifiedDate: '2025-10-15',
        notes: 'Subject to moon sighting',
      },
      2027: {
        date: '2027-07-25',
        status: 'PROVISIONAL',
        verifiedDate: '2025-10-15',
        notes: 'Subject to moon sighting',
      },
    },
  },

  // --- Institutional / School-Specific Recommended Closures ---
  {
    key: 'SUMMER_VACATION_START',
    name: 'Summer Vacation (School Closure)',
    kind: 'NON_TEACHING_DAY',
    category: 'INSTITUTIONAL',
    jurisdiction: 'Bihar',
    isGovernmentMandated: false,
    source: RECOMMENDED_INSTITUTIONAL,
    dates: {
      2025: {
        date: '2025-05-26',
        status: 'UNVERIFIED',
        verifiedDate: null,
        notes: 'Institution discretion; configure custom dates as needed',
      },
      2026: {
        date: '2026-05-25',
        status: 'UNVERIFIED',
        verifiedDate: null,
        notes: 'Institution discretion; configure custom dates as needed',
      },
      2027: {
        date: '2027-05-24',
        status: 'UNVERIFIED',
        verifiedDate: null,
        notes: 'Institution discretion; configure custom dates as needed',
      },
    },
  },
  {
    key: 'WINTER_BREAK',
    name: 'Winter Break (School Closure)',
    kind: 'NON_TEACHING_DAY',
    category: 'INSTITUTIONAL',
    jurisdiction: 'Bihar',
    isGovernmentMandated: false,
    source: RECOMMENDED_INSTITUTIONAL,
    dates: {
      2025: {
        date: '2025-12-29',
        status: 'UNVERIFIED',
        verifiedDate: null,
        notes: 'Institution discretion; configure custom dates as needed',
      },
      2026: {
        date: '2026-12-28',
        status: 'UNVERIFIED',
        verifiedDate: null,
        notes: 'Institution discretion; configure custom dates as needed',
      },
      2027: {
        date: '2027-12-28',
        status: 'UNVERIFIED',
        verifiedDate: null,
        notes: 'Institution discretion; configure custom dates as needed',
      },
    },
  },
];

export interface CatalogueFilterOptions {
  country?: string | undefined; // default 'IN'
  state?: string | undefined; // 'BR' for Bihar, 'ALL' for central only
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

/**
 * Returns annual holiday suggestions for the specified date window and geographic jurisdiction.
 * Supports academic years spanning multiple calendar years (e.g. 2026-04-01 to 2027-03-31).
 */
export function getHolidaySuggestions(options: CatalogueFilterOptions): HolidayCatalogueEntry[] {
  const from = options.from;
  const to = options.to;
  if (!from || !to || to < from) return [];

  const startYear = parseInt(from.slice(0, 4), 10);
  const endYear = parseInt(to.slice(0, 4), 10);
  const selectedState = (options.state || 'BR').toUpperCase();

  const results: HolidayCatalogueEntry[] = [];

  for (const seed of CATALOGUE_SEEDS) {
    // If state filter is set and not 'ALL', exclude state-specific seeds for other jurisdictions
    if (selectedState !== 'ALL' && selectedState !== 'BR' && seed.jurisdiction === 'Bihar') {
      continue;
    }
    // If filtering only ALL (Central / Nationwide), exclude state-specific seeds
    if (selectedState === 'ALL' && seed.jurisdiction !== 'India') {
      continue;
    }

    // Inspect each calendar year spanned by the academic window
    for (let yr = startYear; yr <= endYear; yr++) {
      const yearData = seed.dates[yr];
      if (yearData) {
        if (yearData.date >= from && yearData.date <= to) {
          results.push({
            id: `CAT-${seed.key}-${yr}`,
            holidayDate: yearData.date,
            name: seed.name,
            kind: seed.kind,
            category: seed.category,
            jurisdiction: seed.jurisdiction,
            year: yr,
            source: seed.source,
            verificationStatus: yearData.status,
            verifiedDate: yearData.verifiedDate,
            isGovernmentMandated: seed.isGovernmentMandated,
            notes: yearData.notes,
          });
        }
      } else {
        // Year beyond pre-compiled seed table: generate fixed national/state days as VERIFIED,
        // and movable festivals as UNVERIFIED requiring admin confirmation
        const fallback = generateFallbackYearEntry(seed, yr);
        if (fallback && fallback.holidayDate >= from && fallback.holidayDate <= to) {
          results.push(fallback);
        }
      }
    }
  }

  // Sort strictly chronologically by holidayDate, then name
  results.sort((a, b) => {
    const d = a.holidayDate.localeCompare(b.holidayDate);
    if (d !== 0) return d;
    return a.name.localeCompare(b.name);
  });

  return results;
}

/**
 * For calendar years outside 2025-2027:
 * Fixed calendar date holidays remain VERIFIED.
 * Movable festivals without published gazette are marked UNVERIFIED with notes.
 */
function generateFallbackYearEntry(
  seed: RawHolidaySeed,
  year: number,
): HolidayCatalogueEntry | null {
  const fixedMap: Record<string, string> = {
    REPUBLIC_DAY: '-01-26',
    BIHAR_DIWAS: '-03-22',
    AMBEDKAR_JAYANTI: '-04-14',
    INDEPENDENCE_DAY: '-08-15',
    GANDHI_JAYANTI: '-10-02',
    CHRISTMAS_DAY: '-12-25',
  };

  const fixedSuffix = fixedMap[seed.key];
  if (fixedSuffix) {
    return {
      id: `CAT-${seed.key}-${year}`,
      holidayDate: `${year}${fixedSuffix}`,
      name: seed.name,
      kind: seed.kind,
      category: seed.category,
      jurisdiction: seed.jurisdiction,
      year,
      source: seed.source,
      verificationStatus: 'VERIFIED',
      verifiedDate: null,
      isGovernmentMandated: seed.isGovernmentMandated,
      notes: 'Fixed annual government holiday date',
    };
  }

  // Movable festival without confirmed gazette
  return {
    id: `CAT-${seed.key}-${year}`,
    holidayDate: `${year}-01-01`, // Default placeholder requiring admin date correction
    name: seed.name,
    kind: seed.kind,
    category: seed.category,
    jurisdiction: seed.jurisdiction,
    year,
    source: `${seed.source} (Unreleased Gazette)`,
    verificationStatus: 'UNVERIFIED',
    verifiedDate: null,
    isGovernmentMandated: seed.isGovernmentMandated,
    notes:
      'Official gazette notification pending for this calendar year. Date must be confirmed by administrator.',
  };
}
