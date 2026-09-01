variable "aws_region" {
  type    = string
  default = "eu-central-1"
}

variable "name" {
  type    = string
  default = "botpol"
}

variable "web_image" {
  type        = string
  description = "ECR image URI for the Next.js dashboard"
}

variable "worker_image" {
  type        = string
  description = "ECR image URI for Node workers"
}

variable "desired_web" {
  type    = number
  default = 1
}

variable "desired_live_workers" {
  type    = number
  default = 1
}

variable "desired_paper_workers" {
  type    = number
  default = 1
}

variable "certificate_arn" {
  type        = string
  default     = ""
  description = "ACM cert for HTTPS. Empty = HTTP only (research)."
}

variable "binance_paper_api_key" {
  type      = string
  default   = ""
  sensitive = true
}

variable "binance_paper_api_secret" {
  type      = string
  default   = ""
  sensitive = true
}

variable "binance_prediction_wallet_address" {
  type      = string
  default   = ""
  sensitive = true
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.micro"
}
