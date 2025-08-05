import { Injectable, BadRequestException, NotFoundException, InternalServerErrorException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAbsensiDto, UpdateAbsensiDto, AbsensiQueryDto } from './dto/absensi.dto';
import { AbsensiStatus } from '@prisma/client';

@Injectable()
export class AbsensiService {
  constructor(private prisma: PrismaService) {}

  async absenMasuk(userId: number, createAbsensiDto: CreateAbsensiDto) {
    if (!userId || !createAbsensiDto) {
      throw new BadRequestException('userId and absensi data are required');
    }
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      const tomorrow = new Date(today);
      tomorrow.setDate(today.getDate() + 1);

      // Find today's shift for this user
      const shift = await this.prisma.shift.findFirst({
        where: {
          userId: userId,
          tanggal: {
            gte: today,
            lt: tomorrow
          }
        }
      });

      if (!shift) {
        throw new Error('Tidak Ada Shift Untuk Hari Ini');
      }

      // Check if already checked in
      const existingAbsensi = await this.prisma.absensi.findFirst({
        where: { 
          userId: userId,
          shiftId: shift.id 
        }
      });

      if (existingAbsensi) {
        throw new Error('Sudah Melakukan Absen Masuk Untuk Shift Ini');
      }

      const jamMasuk = new Date();
      const shiftStartTime = shift.jammulai.toTimeString().split(' ')[0]; // Convert DateTime to HH:MM:SS format
      const status = this.determineStatus(shiftStartTime, jamMasuk);

      return this.prisma.absensi.create({
        data: {
          userId: userId,
          shiftId: shift.id,
          jamMasuk: jamMasuk,
          status: status,
          lokasi: createAbsensiDto.lokasi,
          foto: createAbsensiDto.foto,
          catatan: createAbsensiDto.catatan
        },
        include: {
          user: {
            select: {
              namaDepan: true,
              namaBelakang: true
            }
          },
          shift: true
        }
      });
    } catch (error) {
      console.error('[AbsensiService][absenMasuk] Error:', error);
      throw new InternalServerErrorException(error.message || 'Failed to absen masuk');
    }
  }

  async absenKeluar(absensiId: number, updateAbsensiDto: UpdateAbsensiDto) {
    if (!absensiId || !updateAbsensiDto) {
      throw new BadRequestException('absensiId and update data are required');
    }
    try {
      const absensi = await this.prisma.absensi.findUnique({
        where: { id: absensiId },
        include: { shift: true }
      });

      if (!absensi) {
        throw new Error('Data Absensi Tidak Ditemukan');
      }

      if (absensi.jamKeluar) {
        throw new Error('Sudah Melakukan Absen Keluar');
      }

      const jamKeluar = new Date();

      return this.prisma.absensi.update({
        where: { id: absensiId },
        data: {
          jamKeluar: jamKeluar,
          ...updateAbsensiDto
        },
        include: {
          user: {
            select: {
              namaDepan: true,
              namaBelakang: true
            }
          },
          shift: true
        }
      });
    } catch (error) {
      console.error('[AbsensiService][absenKeluar] Error:', error);
      throw new InternalServerErrorException(error.message || 'Failed to absen keluar');
    }
  }

  async getUserAttendance(userId: number, query: AbsensiQueryDto) {
    const where: any = { userId };

    if (query.startDate && query.endDate) {
      where.createdAt = {
        gte: new Date(query.startDate),
        lte: new Date(query.endDate)
      };
    }

    if (query.status) {
      where.status = query.status;
    }

    return this.prisma.absensi.findMany({
      where,
      include: {
        shift: true,
        user: {
          select: {
            namaDepan: true,
            namaBelakang: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: typeof query.limit === 'string' ? parseInt(query.limit) : (query.limit || 50),
      skip: typeof query.offset === 'string' ? parseInt(query.offset) : (query.offset || 0)
    });
  }

  async getTodayAttendance(userId: number) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    // Get today's shift
    const shift = await this.prisma.shift.findFirst({
      where: {
        userId: userId,
        tanggal: {
          gte: today,
          lt: tomorrow
        }
      }
    });

    if (!shift) {
      return { shift: null, absensi: null };
    }

    // Get attendance for this shift
    const absensi = await this.prisma.absensi.findFirst({
      where: { 
        userId: userId,
        shiftId: shift.id 
      },
      include: {
        user: {
          select: {
            namaDepan: true,
            namaBelakang: true
          }
        }
      }
    });

    return { shift, absensi };
  }

  async getAllAttendance(query: AbsensiQueryDto) {
    const where: any = {};

    if (query.startDate && query.endDate) {
      where.createdAt = {
        gte: new Date(query.startDate),
        lte: new Date(query.endDate)
      };
    }

    if (query.status) {
      where.status = query.status;
    }

    if (query.userId) {
      where.userId = +query.userId;
    }

    return this.prisma.absensi.findMany({
      where,
      include: {
        user: {
          select: {
            namaDepan: true,
            namaBelakang: true,
            role: true
          }
        },
        shift: true
      },
      orderBy: {
        createdAt: 'desc'
      },
      take: typeof query.limit === 'string' ? parseInt(query.limit) : (query.limit || 100),
      skip: typeof query.offset === 'string' ? parseInt(query.offset) : (query.offset || 0)
    });
  }

  async getAdminDashboardStats() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    // Today's attendance stats
    const todayStats = await this.prisma.absensi.groupBy({
      by: ['status'],
      where: {
        createdAt: {
          gte: today,
          lt: tomorrow
        }
      },
      _count: {
        status: true
      }
    });

    // Users who haven't checked in today
    const allUsersWithShiftToday = await this.prisma.shift.findMany({
      where: {
        tanggal: {
          gte: today,
          lt: tomorrow
        }
      },
      include: {
        user: {
          select: {
            id: true,
            namaDepan: true,
            namaBelakang: true
          }
        },
        absensi: true
      }
    });

    const usersNotCheckedIn = allUsersWithShiftToday
      .filter((shift) => !shift.absensi)
      .map((shift) => shift.user);

    // Deduplicate users by ID
    const uniqueUsersNotCheckedIn = usersNotCheckedIn.filter((user, index, self) => 
      index === self.findIndex((u) => u.id === user.id)
    );

    return {
      todayStats,
      usersNotCheckedIn: uniqueUsersNotCheckedIn,
      totalShiftsToday: allUsersWithShiftToday.length
    };
  }

  async getUserDashboardStats(userId: number) {
    const thisMonth = new Date();
    thisMonth.setDate(1);
    thisMonth.setHours(0, 0, 0, 0);

    const nextMonth = new Date(thisMonth);
    nextMonth.setMonth(thisMonth.getMonth() + 1);

    const monthlyStats = await this.prisma.absensi.groupBy({
      by: ['status'],
      where: {
        userId: userId,
        createdAt: {
          gte: thisMonth,
          lt: nextMonth
        }
      },
      _count: {
        status: true
      }
    });

    return { monthlyStats };
  }

  async verifyAttendance(absensiId: number, updateData: any) {
    // Remove invalid 'verified' field and set appropriate status
    const { verified, ...validData } = updateData;
    
    // If trying to verify, set status to HADIR and add verification note
    if (verified) {
      validData.status = 'HADIR';
      validData.catatan = validData.catatan 
        ? `${validData.catatan} - Verified by admin`
        : 'Verified by admin';
    }
    
    return this.prisma.absensi.update({
      where: { id: absensiId },
      data: validData,
      include: {
        user: {
          select: {
            namaDepan: true,
            namaBelakang: true
          }
        },
        shift: true
      }
    });
  }

  async getMonthlyReport(query: any) {
    const { year, month, userId } = query;
    
    // Use current date as fallback if year/month not provided
    const currentDate = new Date();
    const reportYear = year ? parseInt(year) : currentDate.getFullYear();
    const reportMonth = month ? parseInt(month) : currentDate.getMonth() + 1;
    
    const startDate = new Date(reportYear, reportMonth - 1, 1);
    const endDate = new Date(reportYear, reportMonth, 0, 23, 59, 59);

    const where: any = {
      createdAt: {
        gte: startDate,
        lte: endDate
      }
    };

    if (userId) {
      where.userId = +userId;
    }

    return this.prisma.absensi.findMany({
      where,
      include: {
        user: {
          select: {
            namaDepan: true,
            namaBelakang: true,
            role: true
          }
        },
        shift: true
      },
      orderBy: [
        { user: { namaDepan: 'asc' } },
        { createdAt: 'asc' }
      ]
    });
  }

  async getAttendanceStats(query: any) {
    const { startDate, endDate, userId } = query;
    
    const where: any = {};

    if (startDate && endDate) {
      where.createdAt = {
        gte: new Date(startDate),
        lte: new Date(endDate)
      };
    }

    if (userId) {
      where.userId = +userId;
    }

    const stats = await this.prisma.absensi.groupBy({
      by: ['status'],
      where,
      _count: {
        status: true
      }
    });

    const total = stats.reduce((sum, stat) => sum + stat._count.status, 0);

    return {
      stats,
      total,
      percentage: stats.map(stat => ({
        status: stat.status,
        count: stat._count.status,
        percentage: ((stat._count.status / total) * 100).toFixed(2)
      }))
    };
  }

  private determineStatus(shiftStart: string, actualTime: Date): AbsensiStatus {
    const [hours, minutes] = shiftStart.split(':').map(Number);
    const shiftDateTime = new Date(actualTime);
    shiftDateTime.setHours(hours, minutes, 0, 0);

    const timeDifference = actualTime.getTime() - shiftDateTime.getTime();
    const minutesLate = Math.floor(timeDifference / (1000 * 60));

    if (minutesLate <= 15) {
      return AbsensiStatus.HADIR;
    } else {
      return AbsensiStatus.TERLAMBAT;
    }
  }
}
