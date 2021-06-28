import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import * as responseTime from 'response-time';
import * as urlParser from 'url';
import { Counter, ValueRecorder } from '@opentelemetry/api-metrics';
import { OpenTelemetryModuleOptions } from '../interfaces';
import { MetricService } from '../metrics/metric.service';
import { OPENTELEMETRY_MODULE_OPTIONS } from '../opentelemetry.constants';

@Injectable()
export class ApiMetricsMiddleware implements NestMiddleware {
  private readonly defaultLongRunningRequestBuckets = [
    0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, // standard
    30, 60, 120, 300, 600, // Sometimes requests may be really long-running
  ];

  private requestTotal: Counter;

  private responseTotal: Counter;

  private responseSuccessTotal: Counter;

  private responseErrorTotal: Counter;

  private responseClientErrorTotal: Counter;

  private responseServerErrorTotal: Counter;

  private requestDuration: ValueRecorder;

  constructor(
    @Inject(OPENTELEMETRY_MODULE_OPTIONS) private readonly options: OpenTelemetryModuleOptions = {},
    @Inject(MetricService) private readonly metricService: MetricService,
  ) {
    this.requestTotal = this.metricService.getCounter('http_request_total', {
      description: 'Total number of HTTP requests',
    });

    this.responseTotal = this.metricService.getCounter('http_response_total', {
      description: 'Total number of HTTP responses',
    });

    this.responseSuccessTotal = this.metricService.getCounter('http_response_success_total', {
      description: 'Total number of all successful responses',
    });

    this.responseErrorTotal = this.metricService.getCounter('http_response_error_total', {
      description: 'Total number of all response errors',
    });

    this.responseClientErrorTotal = this.metricService.getCounter('http_client_error_total', {
      description: 'Total number of client error requests',
    });

    this.responseServerErrorTotal = this.metricService.getCounter('http_server_error_total', {
      description: 'Total number of server error requests',
    });

    const { timeBuckets = [] } = this.options?.withPrometheusExporter?.withHttpMiddleware;
    this.requestDuration = this.metricService.getValueRecorder('http_request_duration_seconds', {
      boundaries: timeBuckets.length > 0 ? timeBuckets : this.defaultLongRunningRequestBuckets,
      description: 'HTTP latency value recorder in seconds',
    });
  }

  use(req, res, next) {
    // eslint-disable-next-line @typescript-eslint/no-shadow
    responseTime((req, res, time) => {
      const { url, method } = req;
      const { path } = urlParser.parse(url);
      if (path === '/favicon.ico') {
        return;
      }
      const metricPath = this.options?.withPrometheusExporter?.metricPath ? this.options.withPrometheusExporter.metricPath : '/metrics';
      if (path === metricPath) {
        return;
      }

      this.requestTotal.bind({ method, path }).add(1);

      const status = res.statusCode || 500;
      const labels = { method, status, path };

      this.countResponse(status, labels, time);
    })(req, res, next);
  }

  private countResponse(statusCode, labels, time) {
    this.responseTotal.bind(labels).add(1);
    this.requestDuration.bind(labels).record(time / 1000);

    const codeClass = this.getStatusCodeClass(statusCode);

    // eslint-disable-next-line default-case
    switch (codeClass) {
      case 'success':
        this.responseSuccessTotal.add(1);
        break;
      case 'redirect':
        // TODO: Review what should be appropriate for redirects.
        this.responseSuccessTotal.add(1);
        break;
      case 'client_error':
        this.responseErrorTotal.add(1);
        this.responseClientErrorTotal.add(1);
        break;
      case 'server_error':
        this.responseErrorTotal.add(1);
        this.responseServerErrorTotal.add(1);
        break;
    }
  }

  private getStatusCodeClass(code: number): string {
    if (code < 200) return 'info';
    if (code < 300) return 'success';
    if (code < 400) return 'redirect';
    if (code < 500) return 'client_error';
    return 'server_error';
  }
}
