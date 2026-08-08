variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "bucket_name" {
  description = "Name of the immutable logs bucket"
  type        = string
  default     = "bench-logs-bucket"
}
