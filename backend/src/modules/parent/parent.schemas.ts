import { Type, type Static } from '@sinclair/typebox';

export const ChildParamSchema = Type.Object({
  childId: Type.String({ format: 'uuid' }),
});
export type ChildParam = Static<typeof ChildParamSchema>;

export const ParentChildDtoSchema = Type.Object({
  studentId: Type.String({ format: 'uuid' }),
  admissionNumber: Type.String(),
  displayName: Type.String(),
  status: Type.String(),
  campusName: Type.Union([Type.String(), Type.Null()]),
  programName: Type.Union([Type.String(), Type.Null()]),
  cohortName: Type.Union([Type.String(), Type.Null()]),
  relation: Type.String(),
  isPrimary: Type.Boolean(),
  canViewAcademics: Type.Boolean(),
  canReceiveNotifications: Type.Boolean(),
});
export type ParentChildDto = Static<typeof ParentChildDtoSchema>;

export const GetParentChildrenResponseSchema = Type.Object({
  success: Type.Literal(true),
  data: Type.Array(ParentChildDtoSchema),
});

export const GetChildSummaryResponseSchema = Type.Object({
  success: Type.Literal(true),
  data: Type.Object({
    child: ParentChildDtoSchema,
    attendance: Type.Object({
      rate: Type.Number(),
      conducted: Type.Number(),
      present: Type.Number(),
      absent: Type.Number(),
    }),
    academics: Type.Object({
      coursesCount: Type.Number(),
      todaySchedule: Type.Array(
        Type.Object({
          period: Type.String(),
          subject: Type.String(),
          teacher: Type.String(),
          time: Type.String(),
          room: Type.Optional(Type.String()),
        }),
      ),
    }),
    examinations: Type.Object({
      latestPublished: Type.Array(
        Type.Object({
          examName: Type.String(),
          courseName: Type.String(),
          marksObtained: Type.Number(),
          maxMarks: Type.Number(),
          grade: Type.String(),
          publishedDate: Type.String(),
        }),
      ),
    }),
    fees: Type.Object({
      totalOutstanding: Type.Number(),
      currency: Type.String(),
      nextDue: Type.Optional(
        Type.Object({
          amount: Type.Number(),
          dueDate: Type.String(),
          title: Type.String(),
        }),
      ),
    }),
  }),
});

export const GetChildAttendanceResponseSchema = Type.Object({
  success: Type.Literal(true),
  data: Type.Object({
    attendanceRate: Type.Number(),
    totalSessions: Type.Number(),
    presentCount: Type.Number(),
    absentCount: Type.Number(),
    lateCount: Type.Number(),
    records: Type.Array(
      Type.Object({
        date: Type.String(),
        period: Type.String(),
        courseName: Type.String(),
        status: Type.String(),
        remarks: Type.Optional(Type.String()),
      }),
    ),
  }),
});

export const GetChildAcademicsResponseSchema = Type.Object({
  success: Type.Literal(true),
  data: Type.Object({
    courses: Type.Array(
      Type.Object({
        courseCode: Type.String(),
        courseName: Type.String(),
        facultyName: Type.Optional(Type.String()),
      }),
    ),
    timetable: Type.Array(
      Type.Object({
        dayOfWeek: Type.String(),
        period: Type.String(),
        courseName: Type.String(),
        roomName: Type.Optional(Type.String()),
      }),
    ),
    homeworkService: Type.Object({
      status: Type.Literal('NOT_CONFIGURED'),
      message: Type.String(),
    }),
  }),
});

export const GetChildExaminationsResponseSchema = Type.Object({
  success: Type.Literal(true),
  data: Type.Object({
    publishedResults: Type.Array(
      Type.Object({
        scheduleId: Type.String(),
        examName: Type.String(),
        courseCode: Type.String(),
        courseName: Type.String(),
        marksObtained: Type.Number(),
        maxMarks: Type.Number(),
        grade: Type.String(),
        publishedDate: Type.String(),
      }),
    ),
    upcomingExams: Type.Array(
      Type.Object({
        examName: Type.String(),
        courseName: Type.String(),
        date: Type.String(),
        time: Type.String(),
      }),
    ),
  }),
});

export const GetChildFeesResponseSchema = Type.Object({
  success: Type.Literal(true),
  data: Type.Object({
    summary: Type.Object({
      totalBilled: Type.Number(),
      totalPaid: Type.Number(),
      totalOutstanding: Type.Number(),
      currency: Type.String(),
    }),
    dues: Type.Array(
      Type.Object({
        id: Type.String(),
        dueNumber: Type.String(),
        title: Type.String(),
        dueDate: Type.String(),
        amount: Type.Number(),
        paidAmount: Type.Number(),
        balanceAmount: Type.Number(),
        status: Type.String(),
      }),
    ),
    receipts: Type.Array(
      Type.Object({
        receiptNumber: Type.String(),
        receiptDate: Type.String(),
        amount: Type.Number(),
        paymentMode: Type.String(),
        status: Type.String(),
      }),
    ),
  }),
});

export const InitiateChildPaymentBodySchema = Type.Object({
  dueId: Type.String({ format: 'uuid' }),
  provider: Type.Optional(Type.Union([Type.Literal('RAZORPAY'), Type.Literal('CASHFREE'), Type.Literal('PHONEPE')])),
});
export type InitiateChildPaymentBody = Static<typeof InitiateChildPaymentBodySchema>;
