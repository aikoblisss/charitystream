import { Campaign, Donor } from './types';

export const DONORS_DATA: Donor[] = [
  {
    id: 1,
    rank: 1,
    name: 'Brand B Inc.',
    amount: 2105,
    avatarUrl: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAGxbsqECd2VA17K1Ke6ENiFS_KJ4n6c2t41xzQW9TEI557Bf9j4z1kMVZIvKMsrc2wT9tTAaRbdzkeateuaDyTnwlmZgW2VWIb94LuyPOWhzcYYHgb_2nlmGr60TkONSYLau_Ypu_VeIIBDUSh7lWJJYoLB7AyVs4LQX1UPCnChMv582JTAdjoYbarbFOxiLGOX-2dDP2JNM6qE6vxViBxNf025U23-0aIW6Xz1f1wK6ziYdjO00TFJpzP2eMB_rgNGQ94DKlPw3Rj'
  },
  {
    id: 3,
    rank: 2,
    name: 'Anonymous',
    amount: 1750,
    avatarUrl: 'https://lh3.googleusercontent.com/aida-public/AB6AXuByyAdS70p05EHSp7gDU8IT011xjy-F6f9Pa9czh0B2cGxjpJZDR7WJY3VYMpZphwtfcxklQm1wyqiLyVWw_Dwdy5q9FEoAwziwyQGNdff99EWauZg4cyGebPrvoHSfEpmlmskOYYkVdlJiHQuKB91ApxXxipPFaajV4IQEI1gqHd9LiTnK5bxYp5hl7Qbgz533ehsVUSi8m7Adz1tEexm5Z5JcXkwS3ZNQVnObCVGyzt_mcOlufKW1D5U1dOOLUZgoW8VgYellwqB1'
  },
  {
    id: 4,
    rank: 3,
    name: 'Growth Co.',
    amount: 1520,
    avatarUrl: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCQN3TX8TP4Egu2OCjbGU1y7qUcRX0_imZsQeTzWssPWkJm1iLKB0KDyKpdJoWglleyZJ6FlQOodN6P61Jc7CkmfDLqQUs_Ab98ZMQcnqcYW1LthnqxNmqh12_ymoVP5XKGvkm7dKhjgP-APfzo7YKbz4SV5NT4ShFXsZq0AS_dfXkAWgeteaSO6wZPkV4_Br9UHj3ThLnzVxNxeImT_1MslYud6o5C2O4TAmlxR7aY6D2Ie-yRfukIewnGSc8tAdQShfPwwfsctztd'
  },
  {
    id: 2,
    rank: 18,
    name: 'You',
    amount: 145,
    avatarUrl: 'https://lh3.googleusercontent.com/aida-public/AB6AXuArvWKlzhtvaNW9P8xgSTnDME9vbooaVGYpIj6agigLDkjIHUM-1bPSVGrY2p35CKzzFb5JZXMsNX-ZfIcfQ1l5hDHm4odmafgzxd6syESI6zkm_GIp17GNvBkm0q8kjUfKKXvn-OA0IrisysUsu-252MdoEH-xQUfEV3sFfT4LN5ChTrnYDyXDfO4-0DZWF-d-pVgqPL9dV_b_lmweWL72yyUfzdx1nJvDU_gcBfS1F86j3m9J9mcZOuvOQHqtd_OjECUiXPbQ4pvD'
  }
];

export const ALL_CAMPAIGNS: Campaign[] = [
  {
    id: '1',
    name: 'Brand A Campaign',
    type: 'Weekly charity campaign',
    status: 'LIVE',
    startDate: '2024-10-01',
    stats: {
      views: 1234567,
      spent: 7500,
      totalBudget: 10000,
      cpm: 5.00,
      weeklyDonations: 1860,
      weeklyGoal: 2500,
      lastUpdated: '2 minutes ago'
    },
    recipient: {
      name: 'WaterAid',
      description: 'Clean water for everyone.',
      logoUrl: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDExacb0w-Bka6lyU7In1iZYlxskzGWQZ_HEikbmW6PuFzjE7It2kXtt9LsjZz5GKMBDl0A1G56DtmILe-pUeibktQvowRxdlE32-8X2_YEyQenPunpcyrIqyDZOIbzbwn1SgMPtFo6qlohjc2W79nnqeT1AhwUvpCuCHuZN6iCpA5gkCG53KcvBa6YWEd0g-MWLzVY9fms6m1_nDyDK7P-I-YMbmeU-EAops2NPialocUPYSCMV6H50WAIz4Q3Fke-slK52gp9ynQl'
    },
    creative: {
      imageUrl: 'https://lh3.googleusercontent.com/aida-public/AB6AXuARdKqZ347uJPPCYHvuLDWrbYv0TXatC5e4bPE0GjajUpTxzAeVRSDvL-UUmx03bCpvvOKUtOiNWebv3p06SeiX-kulLsZoiiVlZV_GzTrMv7_R1fgPtM9pKgdAk8o1EIfaKvwh32aKSbbSD0GxRJeDEwcIWI5H4EQaQzNXAj3Mc5SF0WACI3YGI07jz5eEJRcT3GsuOvkUPnP6BYFJZGnG0-3psYq3QwCvPioNZXMw_73EDL0TN14eBWghG-qnxVINANJZFMkUQuKp'
    }
  },
  {
    id: '2',
    name: 'Holiday Special 2024',
    type: 'Seasonal Fundraiser',
    status: 'PAUSED',
    startDate: '2024-09-15',
    stats: {
      views: 450000,
      spent: 1200,
      totalBudget: 5000,
      cpm: 4.80,
      weeklyDonations: 450,
      weeklyGoal: 1000,
      lastUpdated: '2 hours ago'
    },
    recipient: {
      name: 'Red Cross',
      description: 'Alleviating human suffering.',
      logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c9/Red_Cross_icon.svg/1024px-Red_Cross_icon.svg.png'
    },
    creative: {
      imageUrl: 'https://images.unsplash.com/photo-1512909006721-3d6018887383?auto=format&fit=crop&q=80&w=2000'
    }
  },
  {
    id: '3',
    name: 'Q3 Awareness',
    type: 'Brand Awareness',
    status: 'ENDED',
    startDate: '2024-07-01',
    stats: {
      views: 2500000,
      spent: 15000,
      totalBudget: 15000,
      cpm: 6.00,
      weeklyDonations: 5000,
      weeklyGoal: 5000,
      lastUpdated: 'Oct 01, 2024'
    },
    recipient: {
      name: 'WWF',
      description: 'Wilderness preservation.',
      logoUrl: 'https://upload.wikimedia.org/wikipedia/en/thumb/2/24/WWF_logo.svg/1200px-WWF_logo.svg.png'
    },
    creative: {
      imageUrl: 'https://images.unsplash.com/photo-1549421263-6064833b071b?auto=format&fit=crop&q=80&w=2000'
    }
  },
  {
    id: '4',
    name: 'New Product Launch',
    type: 'Product Integration',
    status: 'IN REVIEW',
    startDate: '2024-10-20',
    stats: {
      views: 0,
      spent: 0,
      totalBudget: 20000,
      cpm: 0,
      weeklyDonations: 0,
      weeklyGoal: 3000,
      lastUpdated: 'Just now'
    },
    recipient: {
      name: 'Unicef',
      description: 'For every child.',
      logoUrl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ed/UNICEF_Logo.png/1200px-UNICEF_Logo.png'
    },
    creative: {
      imageUrl: 'https://images.unsplash.com/photo-1600880292203-757bb62b4baf?auto=format&fit=crop&q=80&w=2000'
    }
  },
  {
    id: '5',
    name: 'Emergency Relief Fund',
    type: 'Disaster Response',
    status: 'LIVE',
    startDate: '2024-10-05',
    stats: {
      views: 890000,
      spent: 12400,
      totalBudget: 50000,
      cpm: 5.50,
      weeklyDonations: 8500,
      weeklyGoal: 10000,
      lastUpdated: '15 minutes ago'
    },
    recipient: {
      name: 'Doctors Without Borders',
      description: 'Medical humanitarian aid.',
      logoUrl: 'https://upload.wikimedia.org/wikipedia/en/thumb/b/bd/Msf_logo.svg/1200px-Msf_logo.svg.png'
    },
    creative: {
      imageUrl: 'https://images.unsplash.com/photo-1584515933487-779824d29309?auto=format&fit=crop&q=80&w=2000'
    }
  },
  {
    id: '6',
    name: 'Education For All',
    type: 'Community Support',
    status: 'ENDED',
    startDate: '2024-06-10',
    stats: {
      views: 1100000,
      spent: 7950,
      totalBudget: 8000,
      cpm: 4.20,
      weeklyDonations: 1200,
      weeklyGoal: 1200,
      lastUpdated: 'Aug 01, 2024'
    },
    recipient: {
      name: 'Save the Children',
      description: 'Protecting children.',
      logoUrl: 'https://upload.wikimedia.org/wikipedia/en/thumb/8/87/Save_the_Children_logo.svg/1200px-Save_the_Children_logo.svg.png'
    },
    creative: {
      imageUrl: 'https://images.unsplash.com/photo-1497633762265-9d179a990aa6?auto=format&fit=crop&q=80&w=2000'
    }
  }
];